import {
  MarketData,
  PerpetualDataHandler,
  IdxPriceInfo,
  sleepForSec,
} from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";
import { constructRedis, stableStringify } from "../utils.js";
import { LiquidatorConfig, PerpEmergencyMsg } from "../types.js";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider.js";
import { SDK_STATE_REPUBLISH_SECONDS, publishSDKState, refreshSDKStateTTL } from "../sdkState.js";
import { loadWatchlist, PerpStates, publishWatchlist, serializePerpStates } from "../watchlist.js";
import { createLogger } from "../logger.js";

const log = createLogger("commander.distributor");

export default class Distributor {
  // objects
  private md: MarketData;
  private redisSubClient: Redis;
  private redisPubClient: Redis;
  private provider: MultiUrlJsonRpcProvider;

  // state
  private symbols: Set<string> = new Set();
  private symbolsByPool: Map<number, Set<string>> = new Map();
  private pxSubmission: Map<string, IdxPriceInfo> = new Map();
  private pricesFetchedAt: Map<string, number> = new Map();
  private lastCheckedPx: Map<string, IdxPriceInfo> = new Map();
  private lastCheckedAt: Map<string, number> = new Map();
  private messageSentAt: Map<string, Map<string, number>> = new Map();
  private lastPublishedState: string | undefined;
  private lastPublishedWatchlist: string | undefined;
  private reconcileInflight: Promise<void> | null = null;
  private lastReconcileAttemptAt = 0;
  private lastReconcileSuccessAt = 0;
  private static readonly RECONCILE_TICK_MS = 60 * 1_000;
  private static readonly RECONCILE_STALE_MS = 30 * 60 * 1_000;
  private static readonly RECONCILE_EVENT_MIN_GAP_MS = 2_000;
  public ready: boolean = false;

  private config: LiquidatorConfig;
  private chainId: number;

  constructor(config: LiquidatorConfig) {
    this.config = config;
    this.redisSubClient = constructRedis("commanderSubClient");
    this.redisPubClient = constructRedis("commanderPubClient");
    const sdkConfig = PerpetualDataHandler.readSDKConfig(config.sdkConfig);
    if (config.priceFeedEndpoints.length > 0) {
      sdkConfig.priceFeedEndpoints = config.priceFeedEndpoints;
      log.info({ priceFeedEndpoints: sdkConfig.priceFeedEndpoints }, "Using user specified price feed endpoints");
    }
    this.chainId = sdkConfig.chainId;
    this.md = new MarketData(sdkConfig);
    this.provider = new MultiUrlJsonRpcProvider(this.config.rpcWatch, this.md.network, {
      timeoutSeconds: 25,
      logErrors: true,
      logRpcSwitches: true,
      switchRpcOnEachRequest: true,
      staticNetwork: true,
    });
  }

  public async initialize() {
    try {
      await this.md.createProxyInstance(this.provider);
    } catch (e) {
      throw new Error(
        `commander: all RPCs are down (${this.config.rpcWatch.join(", ")}): ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }

    const info = await this.md.exchangeInfo();
    await this.publishState();
    setInterval(() => void this.publishState(), SDK_STATE_REPUBLISH_SECONDS * 1000).unref();

    const initial = info.pools
      .filter(({ isRunning }) => isRunning)
      .flatMap((pool) =>
        pool.perpetuals
          .filter(({ state }) => state === "NORMAL")
          .map((perpetual) => `${perpetual.baseCurrency}-${perpetual.quoteCurrency}-${pool.poolSymbol}`),
      );
    for (const symbol of initial) await this.addSymbol(symbol);

    await this.redisSubClient.subscribe(
      "PerpEmergency",
      "PerpNormal",
      "listener-error",
      "switch-mode",
      (err) => {
        if (err) {
          log.error({ err }, "redis subscription failed");
          process.exit(1);
        }
      },
    );

    await this.broadcastWatchlist();
    this.ready = true;
  }

  private async addSymbol(symbol: string): Promise<void> {
    let priceInfo: IdxPriceInfo | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        priceInfo = await this.md.fetchPricesForPerpetual(symbol);
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await sleepForSec(attempt);
      }
    }
    if (!priceInfo) {
      log.warn(
        { symbol, error: lastErr instanceof Error ? lastErr.message : String(lastErr) },
        "addSymbol: skipping - price fetch failed after retries",
      );
      return;
    }
    this.pxSubmission.set(symbol, priceInfo);
    this.symbols.add(symbol);
    const poolId = this.md.getPoolIdFromSymbol(symbol);
    if (poolId) {
      let pool = this.symbolsByPool.get(poolId);
      if (!pool) {
        pool = new Set();
        this.symbolsByPool.set(poolId, pool);
      }
      pool.add(symbol);
    }
  }

  private dropSymbol(symbol: string): boolean {
    if (!this.symbols.delete(symbol)) return false;
    this.pricesFetchedAt.delete(symbol);
    this.messageSentAt.delete(symbol);
    this.pxSubmission.delete(symbol);
    this.lastCheckedPx.delete(symbol);
    this.lastCheckedAt.delete(symbol);
    for (const [poolId, pool] of this.symbolsByPool) {
      if (pool.delete(symbol) && pool.size === 0) {
        this.symbolsByPool.delete(poolId);
      }
    }
    return true;
  }

  private async publishState(): Promise<void> {
    try {
      const state = this.md.exportState();
      const serialized = stableStringify(state);
      if (serialized === this.lastPublishedState) {
        const refreshed = await refreshSDKStateTTL(this.redisPubClient, this.chainId);
        if (refreshed) return;
      }
      await publishSDKState(this.redisPubClient, this.chainId, state);
      this.lastPublishedState = serialized;
    } catch (e) {
      log.error({ err: e }, "failed to publish SDK state");
    }
  }

  private async broadcastWatchlist(): Promise<void> {
    let info;
    try {
      info = await this.md.exchangeInfo();
    } catch (e) {
      log.error({ error: e instanceof Error ? e.message : String(e) }, "broadcastWatchlist: exchangeInfo failed");
      return;
    }
    const states: PerpStates = {};
    for (const pool of info.pools) {
      if (!pool.isRunning) continue;
      for (const p of pool.perpetuals) {
        const sym = `${p.baseCurrency}-${p.quoteCurrency}-${pool.poolSymbol}`;
        if (!this.symbols.has(sym)) continue;
        states[sym] = p.state;
      }
    }
    const payload = serializePerpStates(states);
    if (payload === this.lastPublishedWatchlist) return;
    try {
      await publishWatchlist(this.redisPubClient, this.chainId, payload);
      this.lastPublishedWatchlist = payload;
    } catch (e) {
      log.error({ err: e }, "failed to publish watchlist");
    }
  }

  private requireReady() {
    if (!this.ready) {
      throw new Error("not ready: await distributor.initialize()");
    }
  }

  private async onPerpEmergency(msg: PerpEmergencyMsg): Promise<void> {
    if (!this.dropSymbol(msg.symbol)) return;
    log.info({ ...msg }, "perp dropped");
    await this.broadcastWatchlist();
  }

  public async run(): Promise<void> {
    this.requireReady();

    setInterval(() => {
      if (this.symbols.size === 0) {
        void this.reconcileWatchlist();
        return;
      }
      if (Date.now() - this.lastReconcileSuccessAt > Distributor.RECONCILE_STALE_MS) {
        void this.reconcileWatchlist();
      }
    }, Distributor.RECONCILE_TICK_MS).unref();

    const pollMs = this.config.fetchPricesIntervalSecondsMin * 1_000;
    setInterval(() => {
      void this.evaluateAndCheck();
    }, pollMs).unref();

    this.redisSubClient.on("message", async (channel, msg) => {
      switch (channel) {
        case "PerpEmergency": {
          await this.onPerpEmergency(JSON.parse(msg) as PerpEmergencyMsg);
          break;
        }

        case "PerpNormal":
        case "listener-error":
        case "switch-mode": {
          if (
            !this.reconcileInflight &&
            Date.now() - this.lastReconcileAttemptAt > Distributor.RECONCILE_EVENT_MIN_GAP_MS
          ) {
            void this.reconcileWatchlist();
          }
          break;
        }
      }
    });
  }

  private async refreshPrices(symbol: string) {
    if (Date.now() - (this.pricesFetchedAt.get(symbol) ?? 0) < this.config.fetchPricesIntervalSecondsMin * 1_000) {
      return true;
    }
    this.pricesFetchedAt.set(symbol, Date.now());
    try {
      const newPxSubmission = await this.md.fetchPricesForPerpetual(symbol);
      this.pxSubmission.set(symbol, newPxSubmission);
    } catch (e) {
      log.error({ err: e }, "error fetching from price service");
      return false;
    }
    return true;
  }

  private async reconcileWatchlist(): Promise<void> {
    if (this.reconcileInflight) return this.reconcileInflight;
    this.lastReconcileAttemptAt = Date.now();
    this.reconcileInflight = (async () => {
      let info;
      try {
        await this.md.refreshSymbols(true);
        info = await this.md.exchangeInfo();
      } catch (e) {
        log.error({ error: e instanceof Error ? e.message : String(e) }, "reconcile failed");
        return;
      }
      const sdkStates: PerpStates = {};
      for (const pool of info.pools) {
        if (!pool.isRunning) continue;
        for (const p of pool.perpetuals) {
          sdkStates[`${p.baseCurrency}-${p.quoteCurrency}-${pool.poolSymbol}`] = p.state;
        }
      }
      const desired = Object.keys(sdkStates).filter((s) => sdkStates[s] === "NORMAL");
      const desiredSet = new Set(desired);
      const currentSet = new Set(this.symbols);
      for (const s of [...this.symbols]) if (!desiredSet.has(s)) this.dropSymbol(s);
      const missing: string[] = [];
      for (const s of desired) {
        if (currentSet.has(s)) continue;
        await this.addSymbol(s);
        if (!this.symbols.has(s)) missing.push(s);
      }
      const states: PerpStates = {};
      for (const sym of this.symbols) {
        states[sym] = sdkStates[sym] ?? "NORMAL";
      }
      const payload = serializePerpStates(states);
      let redisPayload: string | null = null;
      try {
        const redisStates = await loadWatchlist(this.redisPubClient, this.chainId);
        if (redisStates) redisPayload = serializePerpStates(redisStates);
      } catch (e) {
        log.error({ error: e instanceof Error ? e.message : String(e) }, "reconcile: loadWatchlist failed");
      }
      if (redisPayload !== payload || this.lastPublishedWatchlist !== payload) {
        try {
          await publishWatchlist(this.redisPubClient, this.chainId, payload);
          this.lastPublishedWatchlist = payload;
        } catch (e) {
          log.error({ error: e instanceof Error ? e.message : String(e) }, "reconcile: publish failed");
          return;
        }
      }
      // Only mark a successful reconcile (and reset the staleness clock) if
      // every desired NORMAL perp is actually being monitored. Otherwise
      // leave the success clock stale so the next tick retries the missing
      // symbols sooner than RECONCILE_STALE_MS.
      if (missing.length === 0) {
        this.lastReconcileSuccessAt = Date.now();
        log.info({ size: this.symbols.size }, "watchlist reconciled");
      } else {
        log.warn(
          { size: this.symbols.size, missing },
          "watchlist reconciled with missing symbols; will retry next tick",
        );
      }
    })().finally(() => {
      this.reconcileInflight = null;
    });
    return this.reconcileInflight;
  }

  private async evaluateAndCheck(): Promise<void> {
    if (this.symbols.size === 0) return;
    await Promise.allSettled([...this.symbols].map((s) => this.refreshPrices(s)));

    const threshold = this.config.priceMovePctThreshold ?? 0.005;
    const maxIntervalMs = (this.config.checkIntervalSecondsMax ?? 30) * 1_000;
    const now = Date.now();
    const poolsToCheck: number[] = [];
    for (const [poolId, poolSymbols] of this.symbolsByPool) {
      for (const symbol of poolSymbols) {
        if (this.shouldCheck(symbol, now, threshold, maxIntervalMs)) {
          poolsToCheck.push(poolId);
          break;
        }
      }
    }
    if (poolsToCheck.length === 0) return;

    const results = await Promise.allSettled(poolsToCheck.map((id) => this.checkPool(id)));
    results.forEach((r, j) => {
      if (r.status === "rejected") {
        log.error(
          {
            poolId: poolsToCheck[j],
            error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
          "checkPool failed",
        );
      }
    });
  }

  private shouldCheck(symbol: string, now: number, threshold: number, maxIntervalMs: number): boolean {
    if (!this.symbols.has(symbol)) return false;
    const px = this.pxSubmission.get(symbol);
    if (!px || px.s2MktClosed || px.s3MktClosed) return false;
    const lastAt = this.lastCheckedAt.get(symbol) ?? 0;
    if (now - lastAt > maxIntervalMs) return true;
    const lastPx = this.lastCheckedPx.get(symbol);
    if (!lastPx) return true;
    const s2Move = lastPx.s2 > 0 ? Math.abs(px.s2 - lastPx.s2) / lastPx.s2 : 1;
    const s3Last = lastPx.s3 ?? 0;
    const s3Move = s3Last > 0 ? Math.abs((px.s3 ?? 0) - s3Last) / s3Last : 0;
    return s2Move > threshold || s3Move > threshold;
  }

  private async checkPool(poolId: number): Promise<number> {
    const symbols = this.symbolsByPool.get(poolId);
    if (!symbols || symbols.size === 0) return 0;

    const prices = new Map<number, [number, number, number]>();
    const checkedSymbols: string[] = [];
    for (const symbol of symbols) {
      if (!this.symbols.has(symbol)) continue;
      const px = this.pxSubmission.get(symbol);
      if (!px || px.s2MktClosed || px.s3MktClosed) continue;
      const perpId = this.md.getPerpIdFromSymbol(symbol);
      if (perpId === undefined) continue;
      prices.set(perpId, [px.s2, px.s3 ?? 0, px.rho ?? 0]);
      checkedSymbols.push(symbol);
    }
    if (prices.size === 0) return 0;

    let result: Array<{ perpId: number; traders: string[] }>;
    try {
      result = await this.md.getLiquidatableAccountsInPool(
        poolId,
        prices,
        this.config.liquidatableBatchSize ?? 5,
      );
    } catch (e) {
      log.warn(
        { error: e instanceof Error ? e.message : String(e), poolId },
        "getLiquidatableAccountsInPool failed",
      );
      return 0;
    }

    const now = Date.now();
    for (const symbol of checkedSymbols) {
      const px = this.pxSubmission.get(symbol);
      if (px) this.lastCheckedPx.set(symbol, px);
      this.lastCheckedAt.set(symbol, now);
    }

    let totalDue = 0;
    const cooldownMs = this.config.liquidateIntervalSecondsMin * 1_000;
    for (const { perpId, traders } of result) {
      const symbol = this.md.getSymbolFromPerpId(perpId);
      if (!symbol || !this.symbols.has(symbol)) continue;
      let perSymbol = this.messageSentAt.get(symbol);
      if (!perSymbol) {
        perSymbol = new Map();
        this.messageSentAt.set(symbol, perSymbol);
      }
      const dueTraders = traders.filter((t) => now - (perSymbol!.get(t) ?? 0) > cooldownMs);
      if (dueTraders.length === 0) continue;
      await Promise.all(
        dueTraders.map(async (trader) => {
          const m = JSON.stringify({ chainId: this.chainId, symbol, traderAddr: trader });
          await this.redisPubClient.publish("LiquidateTrader", m);
          perSymbol!.set(trader, now);
        }),
      );
      totalDue += dueTraders.length;
    }
    return totalDue;
  }
}
