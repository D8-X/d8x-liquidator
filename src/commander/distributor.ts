import { MarketData, PerpetualDataHandler, IdxPriceInfo, sleepForSec } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";
import { constructRedis, errMsg, stableStringify } from "../utils.js";
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
  private symbols = new Set<string>();
  private symbolsByPool = new Map<number, Set<string>>();
  private pxSubmission = new Map<string, IdxPriceInfo>();
  private pricesFetchedAt = new Map<string, number>();
  private lastPoolCheckedAt = new Map<number, number>();
  private lastCheckedSpotPx = new Map<string, number>();
  private pendingPoolChecks = new Set<number>();
  private processingPools = false;
  private priceWatchInflight = false;
  private messageSentAt = new Map<string, Map<string, number>>();
  private lastPublishedState: string | undefined;
  private lastPublishedWatchlist: string | undefined;
  private reconcileInflight: Promise<void> | null = null;
  private lastReconcileAttemptAt = 0;
  private lastReconcileSuccessAt = 0;
  private static readonly RECONCILE_TICK_MS = 60 * 1_000;
  private static readonly RECONCILE_STALE_MS = 30 * 60 * 1_000;
  private static readonly RECONCILE_EVENT_MIN_GAP_MS = 30_000;
  private static readonly FALLBACK_TICK_MS = 5_000;
  public ready = false;

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
      switchRpcOnEachRequest: this.config.switchRpcOnEachRequest ?? false,
      staticNetwork: true,
    });
  }

  public async initialize(): Promise<void> {
    try {
      await this.md.createProxyInstance(this.provider);
    } catch (e: unknown) {
      throw new Error(`commander: all RPCs are down (${this.config.rpcWatch.join(", ")}): ${errMsg(e)}`, { cause: e });
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

    await this.redisSubClient.subscribe("PerpEmergency", "PerpNormal", "listener-error", "switch-mode", (err) => {
      if (err) {
        log.error({ err }, "redis subscription failed");
        process.exit(1);
      }
    });

    await this.broadcastWatchlist();
    this.lastReconcileSuccessAt = Date.now();
    this.ready = true;
  }

  private async addSymbol(symbol: string): Promise<void> {
    let poolId: number;
    try {
      poolId = this.md.getPoolIdFromSymbol(symbol); // getPoolIdFromSymbol either returns >= 1 or throws
    } catch (e: unknown) {
      log.warn({ symbol, error: errMsg(e) }, "Skipping symbol. Cannot resolve poolId");
      return;
    }

    let priceInfo: IdxPriceInfo | undefined;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        priceInfo = await this.md.fetchPricesForPerpetual(symbol);
        break;
      } catch (e: unknown) {
        lastErr = e;
        if (attempt < 3) await sleepForSec(attempt);
      }
    }
    if (!priceInfo) {
      log.warn({ symbol, error: errMsg(lastErr) }, "addSymbol: skipping - price fetch failed after retries");
      return;
    }

    this.pxSubmission.set(symbol, priceInfo);
    this.symbols.add(symbol);
    let pool = this.symbolsByPool.get(poolId);
    if (!pool) {
      pool = new Set();
      this.symbolsByPool.set(poolId, pool);
    }
    pool.add(symbol);
  }

  private dropSymbol(symbol: string): boolean {
    if (!this.symbols.delete(symbol)) return false;
    this.pricesFetchedAt.delete(symbol);
    this.messageSentAt.delete(symbol);
    this.pxSubmission.delete(symbol);
    this.lastCheckedSpotPx.delete(symbol);
    for (const [poolId, pool] of this.symbolsByPool) {
      if (pool.delete(symbol)) {
        if (pool.size === 0) {
          this.symbolsByPool.delete(poolId);
          this.lastPoolCheckedAt.delete(poolId);
          this.pendingPoolChecks.delete(poolId);
        }
        break;
      }
    }
    return true;
  }

  private async publishState(): Promise<void> {
    try {
      const state = this.md.exportState();
      const serialized: string = stableStringify(state);
      if (serialized === this.lastPublishedState) {
        const refreshed: boolean = await refreshSDKStateTTL(this.redisPubClient, this.chainId);
        if (refreshed) return;
      }
      await publishSDKState(this.redisPubClient, this.chainId, state);
      this.lastPublishedState = serialized;
    } catch (e: unknown) {
      log.error({ err: e }, "failed to publish SDK state");
    }
  }

  private async broadcastWatchlist(): Promise<void> {
    let info: Awaited<ReturnType<MarketData["exchangeInfo"]>>;
    try {
      info = await this.md.exchangeInfo();
    } catch (e: unknown) {
      log.error({ error: errMsg(e) }, "broadcastWatchlist: exchangeInfo failed");
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
    } catch (e: unknown) {
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

  public run(): void {
    this.requireReady();

    setInterval((): void => {
      if (this.symbols.size === 0) {
        void this.reconcileWatchlist();
        return;
      }
      if (Date.now() - this.lastReconcileSuccessAt > Distributor.RECONCILE_STALE_MS) {
        void this.reconcileWatchlist();
      }
    }, Distributor.RECONCILE_TICK_MS).unref();

    setInterval((): void => {
      const maxMs: number = (this.config.checkIntervalSecondsMax ?? 30) * 1_000;
      const now: number = Date.now();
      for (const poolId of this.symbolsByPool.keys()) {
        if (now - (this.lastPoolCheckedAt.get(poolId) ?? 0) > maxMs) {
          this.schedulePoolCheck(poolId);
        }
      }
    }, Distributor.FALLBACK_TICK_MS).unref();

    const watchMs: number = (this.config.priceWatchIntervalSeconds ?? 15) * 1_000;
    setInterval((): void => {
      void this.runPriceWatch();
    }, watchMs).unref();

    this.redisSubClient.on("message", (channel: string, msg: string): void => {
      void this.handleRedisMessage(channel, msg);
    });
  }

  private async handleRedisMessage(channel: string, msg: string): Promise<void> {
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
          await this.reconcileWatchlist();
        }
        break;
      }
    }
  }

  private async runPriceWatch(): Promise<void> {
    if (this.priceWatchInflight) return;
    if (this.symbols.size === 0) return;
    this.priceWatchInflight = true;
    try {
      const symbols = [...this.symbols];
      await Promise.allSettled(symbols.map((s) => this.refreshPrices(s)));

      const threshold = this.config.priceMovePctThreshold ?? 0.01;
      for (const [poolId, poolSymbols] of this.symbolsByPool) {
        for (const symbol of poolSymbols) {
          const px = this.pxSubmission.get(symbol);
          if (!px || px.s2MktClosed || px.s3MktClosed) continue;
          const lastSpot = this.lastCheckedSpotPx.get(symbol);
          if (lastSpot === undefined || lastSpot <= 0) {
            this.schedulePoolCheck(poolId);
            break;
          }
          const move = Math.abs(px.s2 - lastSpot) / lastSpot;
          if (move >= threshold) {
            this.schedulePoolCheck(poolId);
            break;
          }
        }
      }
    } finally {
      this.priceWatchInflight = false;
    }
  }

  private async refreshPrices(symbol: string) {
    if (Date.now() - (this.pricesFetchedAt.get(symbol) ?? 0) < this.config.fetchPricesIntervalSecondsMin * 1_000) {
      return true;
    }
    this.pricesFetchedAt.set(symbol, Date.now());
    try {
      const newPxSubmission: IdxPriceInfo = await this.md.fetchPricesForPerpetual(symbol);
      this.pxSubmission.set(symbol, newPxSubmission);
    } catch (e: unknown) {
      log.error({ err: e }, "error fetching from price service");
      return false;
    }
    return true;
  }

  private async reconcileWatchlist(): Promise<void> {
    if (this.reconcileInflight) return this.reconcileInflight;
    this.lastReconcileAttemptAt = Date.now();
    this.reconcileInflight = (async (): Promise<void> => {
      let info: Awaited<ReturnType<MarketData["exchangeInfo"]>>;
      try {
        await this.md.refreshSymbols(true);
        info = await this.md.exchangeInfo();
      } catch (e: unknown) {
        log.error({ error: errMsg(e) }, "reconcile failed");
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
        const redisStates: PerpStates | null = await loadWatchlist(this.redisPubClient, this.chainId);
        if (redisStates) redisPayload = serializePerpStates(redisStates);
      } catch (e: unknown) {
        log.error({ error: errMsg(e) }, "reconcile: loadWatchlist failed");
      }
      if (redisPayload !== payload || this.lastPublishedWatchlist !== payload) {
        try {
          await publishWatchlist(this.redisPubClient, this.chainId, payload);
          this.lastPublishedWatchlist = payload;
        } catch (e: unknown) {
          log.error({ error: errMsg(e) }, "reconcile: publish failed");
          return;
        }
      }
      await this.publishState();
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
    })().finally((): void => {
      this.reconcileInflight = null;
    });
    return this.reconcileInflight;
  }

  private schedulePoolCheck(poolId: number): void {
    this.pendingPoolChecks.add(poolId);
    if (!this.processingPools) void this.processPendingPools();
  }

  private async processPendingPools(): Promise<void> {
    if (this.processingPools) return;
    this.processingPools = true;
    try {
      while (this.pendingPoolChecks.size > 0) {
        const minMs = (this.config.checkIntervalSecondsMin ?? 2) * 1_000;
        const pools = [...this.pendingPoolChecks];
        this.pendingPoolChecks.clear();
        for (const poolId of pools) {
          const sinceLast = Date.now() - (this.lastPoolCheckedAt.get(poolId) ?? 0);
          if (sinceLast < minMs) {
            await new Promise((resolve) => setTimeout(resolve, minMs - sinceLast));
          }
          try {
            await this.checkPool(poolId);
          } catch (e: unknown) {
            log.error({ poolId, error: errMsg(e) }, "checkPool failed");
          }
        }
      }
    } finally {
      this.processingPools = false;
    }
  }

  private async checkPool(poolId: number): Promise<void> {
    const symbols = this.symbolsByPool.get(poolId);
    if (!symbols || symbols.size === 0) return;

    await Promise.allSettled([...symbols].map((s) => this.refreshPrices(s)));

    const prices: Map<number, [number, number, number]> = new Map<number, [number, number, number]>();
    for (const symbol of symbols) {
      if (!this.symbols.has(symbol)) continue;
      const px: IdxPriceInfo | undefined = this.pxSubmission.get(symbol);
      if (!px || px.s2MktClosed || px.s3MktClosed) continue;
      const perpId: number = this.md.getPerpIdFromSymbol(symbol);
      prices.set(perpId, [px.s2, px.s3 ?? 0, px.rho ?? 0]);
    }
    if (prices.size === 0) return;

    let result: { perpId: number; traders: string[] }[];
    try {
      result = await this.md.getLiquidatableAccountsInPool(poolId, prices, this.config.liquidatableBatchSize ?? 5);
    } catch (e: unknown) {
      log.warn({ error: errMsg(e), poolId }, "getLiquidatableAccountsInPool failed");
      return;
    }
    const liquidatableCount = result.reduce((acc, r) => acc + r.traders.length, 0);
    log.info(
      { poolId, perpsQueried: prices.size, perpsWithLiquidatable: result.length, liquidatableCount },
      "getLiquidatableAccountsInPool ok",
    );

    const now = Date.now();
    this.lastPoolCheckedAt.set(poolId, now);
    for (const symbol of symbols) {
      const px = this.pxSubmission.get(symbol);
      if (px) this.lastCheckedSpotPx.set(symbol, px.s2);
    }

    const cooldownMs: number = this.config.liquidateIntervalSecondsMin * 1_000;
    for (const { perpId, traders } of result) {
      const symbol: string | undefined = this.md.getSymbolFromPerpId(perpId);
      if (!symbol || !this.symbols.has(symbol)) continue;
      let map: Map<string, number> | undefined = this.messageSentAt.get(symbol);
      if (!map) {
        map = new Map<string, number>();
        this.messageSentAt.set(symbol, map);
      }
      const sentAt: Map<string, number> = map;
      const dueTraders: string[] = traders.filter((t: string): boolean => now - (sentAt.get(t) ?? 0) > cooldownMs);
      if (dueTraders.length === 0) continue;
      await Promise.all(
        dueTraders.map(async (trader: string): Promise<void> => {
          const m: string = JSON.stringify({ chainId: this.chainId, symbol, traderAddr: trader });
          await this.redisPubClient.publish("LiquidateTrader", m);
          sentAt.set(trader, now);
        }),
      );
    }
  }
}
