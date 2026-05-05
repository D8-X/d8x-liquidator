import {
  MarketData,
  PerpetualDataHandler,
  IPerpetualManager,
  IdxPriceInfo,
  sleepForSec,
} from "@d8-x/d8x-node-sdk";
import { findLiquidatableTraders, toFixedIdxPrice } from "./liquidationDiscovery.js";
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
  private pxSubmission: Map<string, IdxPriceInfo> = new Map();
  private pricesFetchedAt: Map<string, number> = new Map();
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
      "block",
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
  }

  private dropSymbol(symbol: string): boolean {
    if (!this.symbols.delete(symbol)) return false;
    this.pricesFetchedAt.delete(symbol);
    this.messageSentAt.delete(symbol);
    this.pxSubmission.delete(symbol);
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

    this.redisSubClient.on("message", async (channel, msg) => {
      switch (channel) {
        case "block": {
          const blockSymbols = [...this.symbols];
          const max = this.config.maxConcurrentChecks ?? blockSymbols.length;
          for (let i = 0; i < blockSymbols.length; i += max) {
            const slice = blockSymbols.slice(i, i + max);
            const results = await Promise.allSettled(
              slice.map((symbol) => this.checkPositions(symbol)),
            );
            results.forEach((r, j) => {
              if (r.status === "rejected") {
                log.error(
                  {
                    symbol: slice[j],
                    error: r.reason instanceof Error ? r.reason.message : String(r.reason),
                  },
                  "checkPositions failed",
                );
              }
            });
          }
          break;
        }

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

  private async checkPositions(symbol: string): Promise<number> {
    if (!(await this.refreshPrices(symbol))) return 0;
    if (!this.symbols.has(symbol)) return 0;

    const px = this.pxSubmission.get(symbol)!;
    if (px.s2MktClosed || px.s3MktClosed) return 0;

    const perpId = this.md.getPerpIdFromSymbol(symbol)!;
    const proxy = this.md.getReadOnlyProxyInstance() as any as IPerpetualManager;

    let candidates: string[];
    try {
      candidates = await findLiquidatableTraders(proxy, this.provider, perpId, toFixedIdxPrice(px));
    } catch (e) {
      log.warn(
        { error: e instanceof Error ? e.message : String(e), symbol },
        "getLiquidatableAccounts failed",
      );
      return 0;
    }
    if (candidates.length === 0) return 0;

    let perSymbol = this.messageSentAt.get(symbol);
    if (!perSymbol) {
      perSymbol = new Map();
      this.messageSentAt.set(symbol, perSymbol);
    }
    const now = Date.now();
    const cooldownMs = this.config.liquidateIntervalSecondsMin * 1_000;
    const dueTraders = candidates.filter((t) => now - (perSymbol!.get(t) ?? 0) > cooldownMs);
    if (dueTraders.length === 0) return 0;

    await Promise.all(
      dueTraders.map(async (trader) => {
        const m = JSON.stringify({ chainId: this.chainId, symbol, traderAddr: trader });
        await this.redisPubClient.publish("LiquidateTrader", m);
        perSymbol!.set(trader, now);
      }),
    );
    return dueTraders.length;
  }
}
