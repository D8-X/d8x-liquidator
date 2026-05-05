import {
  MarketData,
  PerpetualDataHandler,
  PriceFeedSubmission,
  ABK64x64ToFloat,
  COLLATERAL_CURRENCY_QUOTE,
  Multicall3__factory,
  MULTICALL_ADDRESS,
  Multicall3,
  IPerpetualManager,
  floatToABK64x64,
  IdxPriceInfo,
  pmExcessBalance,
  sleepForSec,
} from "@d8-x/d8x-node-sdk";
import { BigNumberish } from "ethers";
import { Redis } from "ioredis";
import { constructRedis, stableStringify } from "../utils.js";
import {
  LiquidateMsg,
  LiquidateTraderMsg,
  LiquidatorConfig,
  PerpEmergencyMsg,
  Position,
  UpdateMarginAccountMsg,
  UpdateMarkPriceMsg,
} from "../types.js";
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

  /**
   * Single MultiUrlJsonRpcProvider that internally rotates across the URLs in
   */
  private provider: MultiUrlJsonRpcProvider;

  // state
  private lastRefreshTime: Map<string, number> = new Map();
  private openPositions: Map<string, Map<string, Position>> = new Map();
  private pxSubmission: Map<string, IdxPriceInfo> = new Map();
  private markPremium: Map<string, number> = new Map();
  private messageSentAt: Map<string, Map<string, number>> = new Map();
  private pricesFetchedAt: Map<string, number> = new Map();
  private lastPublishedState: string | undefined;
  private lastPublishedWatchlist: string | undefined;
  private reconcileInflight: Promise<void> | null = null;
  private lastReconcileAt = 0;
  private static readonly RECONCILE_TICK_MS = 60 * 1_000;
  private static readonly RECONCILE_STALE_MS = 30 * 60 * 1_000;
  private static readonly RECONCILE_EVENT_MIN_GAP_MS = 2_000;
  public ready: boolean = false;

  // static info
  private config: LiquidatorConfig;
  private isQuote: Map<string, boolean> = new Map();
  private symbols: Set<string> = new Set();
  private maintenanceRate: Map<string, number> = new Map();
  private chainId: number;

  // publish times must be within 10 seconds of each other, or submission will fail on-chain
  private MAX_OUTOFSYNC_SECONDS: number = 10;

  // Last time refreshAllActiveAccounts was called
  public lastRefreshOfAllActiveAccounts: Date = new Date(0);

  constructor(config: LiquidatorConfig) {
    this.config = config;
    this.redisSubClient = constructRedis("commanderSubClient");
    this.redisPubClient = constructRedis("commanderPubClient");
    const sdkConfig = PerpetualDataHandler.readSDKConfig(config.sdkConfig);
    this.chainId = sdkConfig.chainId;
    this.md = new MarketData(sdkConfig);
    this.provider = new MultiUrlJsonRpcProvider(this.config.rpcWatch, this.md.network, {
      timeoutSeconds: 25,
      logErrors: true,
      logRpcSwitches: true,
      // Distributor uses free rpcs, make sure to switch on each call.
      switchRpcOnEachRequest: true,
      staticNetwork: true,
    });
  }

  /**
   * Connects to the blockchain choosing a random RPC.
   * If none of the RPCs work, it sleeps before crashing.
   */
  public async initialize() {
    // RPC URL randomization happens at config load time using the `shuffle()` in
    // utils.loadConfig, `this.config.rpcWatch` is already a shuffled list by
    // the time it reaches the MultiUrlJsonRpcProvider constructor
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

    // Subscribe to blockchain events
    await this.redisSubClient.subscribe(
      "block",
      "UpdateMarkPriceEvent",
      "UpdateMarginAccountEvent",
      "LiquidateEvent",
      "PerpEmergency",
      "PerpNormal",
      "listener-error",
      "switch-mode",
      (err, count) => {
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
        {
          symbol,
          error: lastErr instanceof Error ? lastErr.message : String(lastErr),
        },
        "addSymbol: skipping - price fetch failed after retries"
      );
      return;
    }
    const info = this.md.getPerpetualStaticInfo(symbol);
    this.maintenanceRate.set(symbol, PerpetualDataHandler.getMaintenanceMarginRate(info));
    this.isQuote.set(symbol, info.collateralCurrencyType == COLLATERAL_CURRENCY_QUOTE);
    this.pxSubmission.set(symbol, priceInfo);
    this.openPositions.set(symbol, new Map());
    this.lastRefreshTime.set(symbol, 0);
    this.symbols.add(symbol);
  }

  private dropSymbol(symbol: string): boolean {
    if (!this.symbols.delete(symbol)) return false;
    this.openPositions.delete(symbol);
    this.lastRefreshTime.delete(symbol);
    this.pricesFetchedAt.delete(symbol);
    this.messageSentAt.delete(symbol);
    this.pxSubmission.delete(symbol);
    this.maintenanceRate.delete(symbol);
    this.isQuote.delete(symbol);
    this.markPremium.delete(symbol);
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
      log.error(
        { error: e instanceof Error ? e.message : String(e) },
        "broadcastWatchlist: exchangeInfo failed"
      );
      return;
    }
    const states: PerpStates = {};
    for (const pool of info.pools) {
      if (!pool.isRunning) continue;
      for (const p of pool.perpetuals) {
        states[`${p.baseCurrency}-${p.quoteCurrency}-${pool.poolSymbol}`] = p.state;
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

  /**
   * Listen to events for a number of blocks; requires initialize() first
   * @param maxBlocks number of blocks we will listen to event handlers
   * @returns void
   */
  public async run(): Promise<void> {
    this.requireReady();

    setInterval(async () => {
      if (
        Date.now() - Math.min(...this.lastRefreshTime.values()) <
        this.config.refreshAccountsIntervalSecondsMax * 1_000
      ) {
        return;
      }
      await this.refreshAllAccounts();
    }, 10_000);

    setInterval(() => {
      if (this.symbols.size === 0) {
        void this.reconcileWatchlist();
        return;
      }
      if (Date.now() - this.lastReconcileAt > Distributor.RECONCILE_STALE_MS) {
        void this.reconcileWatchlist();
      }
    }, Distributor.RECONCILE_TICK_MS);

    this.redisSubClient.on("message", async (channel, msg) => {
      switch (channel) {
        case "block": {
          for (const symbol of this.symbols) {
            try {
              await this.checkPositions(symbol);
            } catch (e) {
              log.error(
                {
                  symbol,
                  error: e instanceof Error ? e.message : String(e),
                },
                "checkPositions failed"
              );
            }
          }
          if (
            Date.now() - Math.min(...this.lastRefreshTime.values()) <
            this.config.refreshAccountsIntervalSecondsMax * 1_000
          ) {
            return;
          }
          await this.refreshAllAccounts();
          break;
        }

        case "UpdateMarginAccountEvent": {
          const account: UpdateMarginAccountMsg = JSON.parse(msg);
          if (account.traderAddr.toLowerCase() == this.md.getProxyAddress().toLowerCase()) return;

          try {
            const pos = await this.fetchPosition(account.perpetualId, account.traderAddr, account.block);
            if (!pos) break;
            await this.updatePosition(pos);
          } catch (e) {
            log.error(
              {
                perpetualId: account.perpetualId,
                traderAddr: account.traderAddr,
                block: account.block,
                error: e instanceof Error ? e.stack ?? e.message : String(e),
              },
              "[@run-UpdateMarginAccountEvent] handler failed"
            );
          }

          break;
        }

        case "UpdateMarkPriceEvent": {
          const { symbol, markPremium }: UpdateMarkPriceMsg = JSON.parse(msg);
          this.markPremium.set(symbol, markPremium);
          break;
        }

        case "PerpEmergency": {
          await this.onPerpEmergency(JSON.parse(msg) as PerpEmergencyMsg);
          break;
        }

        case "PerpNormal": {
          if (!this.reconcileInflight && Date.now() - this.lastReconcileAt > Distributor.RECONCILE_EVENT_MIN_GAP_MS) {
            void this.reconcileWatchlist();
          }
          break;
        }

        case "LiquidateEvent": {
          const { perpetualId, traderAddr, block }: LiquidateMsg = JSON.parse(msg);
          try {
            const pos = await this.fetchPosition(perpetualId, traderAddr, block);
            if (!pos) break;
            await this.updatePosition(pos);
          } catch (e) {
            log.error(
              {
                perpetualId,
                traderAddr,
                block,
                error: e instanceof Error ? e.stack ?? e.message : String(e),
              },
              "[@run-LiquidateEvent] handler failed"
            );
          }
          break;
        }

        case "listener-error":
        case "switch-mode":
          // Whenever something wrong happens on sentinel, refresh orders if
          // they were not refreshed recently in the last 30 (should be more
          // than refreshOrdersIntervalSecondsMin) seconds. Sentinel might
          // have missed events and executed orders might still be held in
          // memory in distributor.
          if (new Date(Date.now() - 30_000) > this.lastRefreshOfAllActiveAccounts) {
            log.warn(
              {
                lastRefreshOfAllOpenOrders: this.lastRefreshOfAllActiveAccounts.toISOString(),
                sentinelReason: channel,
              },
              "Refreshing all active accounts due to sentinel error"
            );
            this.refreshAllAccounts();
          }
          break;
      }
    });

    await this.refreshAllAccounts();
  }

  private async updatePosition(position: Position) {
    const symbol = this.md.getSymbolFromPerpId(position.perpetualId);
    if (!symbol) return;
    let perSymbol = this.openPositions.get(symbol);
    if (!perSymbol) {
      perSymbol = new Map();
      this.openPositions.set(symbol, perSymbol);
    }
    const existing = perSymbol.get(position.address);
    if (existing && existing.block > position.block) return;
    if (position.positionBC === 0) {
      perSymbol.delete(position.address);
    } else {
      perSymbol.set(position.address, position);
    }
  }

  private async fetchPosition(perpetualId: number, address: string, blockTag: number): Promise<Position | undefined> {
    const symbol = this.md.getSymbolFromPerpId(perpetualId);
    if (!symbol) return undefined;
    const pxSubmission = this.pxSubmission.get(symbol);
    if (!pxSubmission) return undefined;
    const prices: [bigint, bigint, bigint] = [
      floatToABK64x64(pxSubmission.s2),
      floatToABK64x64(pxSubmission.s3 ?? 0),
      floatToABK64x64(pxSubmission.rho ?? 0),
    ];
    const account = await this.md.getReadOnlyProxyInstance().getTraderState(perpetualId, address, prices, { blockTag });

    const position: Position = {
      perpetualId: perpetualId,
      address: address,
      positionBC: ABK64x64ToFloat(BigInt(account[4])),
      cashCC: ABK64x64ToFloat(BigInt(account[3])),
      lockedInQC: ABK64x64ToFloat(BigInt(account[5])),
      unpaidFundingCC: ABK64x64ToFloat(BigInt(account[3]) - BigInt(account[2])),
      block: blockTag,
    };
    return position;
  }

  private async refreshAllAccounts() {
    this.lastRefreshOfAllActiveAccounts = new Date();
    await Promise.allSettled([...this.symbols].map((symbol) => this.refreshActiveAccounts(symbol)));
  }

  /**
   * Reset active accounts array
   */
  public async refreshActiveAccounts(symbol: string) {
    this.requireReady();
    if (Date.now() - (this.lastRefreshTime.get(symbol) ?? 0) < this.config.refreshAccountsIntervalSecondsMin * 1_000) {
      log.warn(
        {
          symbol: symbol,
          lastRefresh: new Date(this.lastRefreshTime.get(symbol) ?? 0),
        },
        "[refreshActiveAccounts] called too soon"
      );
      return;
    }
    const chunkSize1 = 2 ** 16; // for addresses
    const chunkSize2 = 2 ** 8; // for margin accounts
    const perpId = this.md.getPerpIdFromSymbol(symbol)!;
    const proxy = this.md.getReadOnlyProxyInstance() as any as IPerpetualManager;
    this.lastRefreshTime.set(symbol, Date.now());
    const blockHeights = await this.provider.getBlockNumberPerUrl();
    if (blockHeights.size === 0) {
      throw new Error(`${symbol}: no rpc returned a block number`);
    }
    const refreshBlock = Math.min(...blockHeights.values());

    let tsStart: number;
    log.debug({ symbol }, "fetching number of accounts");
    tsStart = Date.now();

    const numAccounts = Number(await proxy.countActivePerpAccounts(perpId));
    log.debug({ symbol, activeAccounts: numAccounts }, "fetched active account count");

    // fetch addresses
    const addressFetchPromises: Promise<string[]>[] = [];
    for (let i = 0; i < numAccounts; i += chunkSize1) {
      addressFetchPromises.push(proxy.connect(this.provider).getActivePerpAccountsByChunks(perpId, i, i + chunkSize1));
    }
    let addresses: Set<string> = new Set();
    tsStart = Date.now();
    const addressFetchResults = await Promise.allSettled(addressFetchPromises);
    for (const result of addressFetchResults) {
      if (result.status === "fulfilled") {
        for (const addr of result.value) addresses.add(addr);
      } else {
        log.error(
          {
            symbol,
            error: result.reason instanceof Error ? result.reason.message : String(result.reason),
          },
          "getActivePerpAccountsByChunks failed"
        );
      }
    }

    // fetch accounts
    const traderStatePromises: Promise<Multicall3.ResultStructOutput[]>[] = [];
    const addressChunks: string[][] = [];
    const multicall = Multicall3__factory.connect(MULTICALL_ADDRESS, this.provider);
    const traderList = [...addresses];
    const pxSubmission = this.pxSubmission.get(symbol)!;
    for (let i = 0; i < traderList.length; i += chunkSize2) {
      const addressChunk = traderList.slice(i, i + chunkSize2);
      const calls: Multicall3.Call3Struct[] = addressChunk.map((addr) => ({
        allowFailure: true,
        target: proxy.getAddress(),
        callData: proxy.interface.encodeFunctionData("getTraderState", [
          perpId,
          addr,
          [
            floatToABK64x64(pxSubmission.s2),
            floatToABK64x64(pxSubmission.s3 ?? 0),
            floatToABK64x64(pxSubmission.rho ?? 0),
          ],
        ]),
      }));
      traderStatePromises.push(multicall.aggregate3.staticCall(calls, { blockTag: refreshBlock }));
      addressChunks.push(addressChunk);
    }

    tsStart = Date.now();
    const traderStateResults = await Promise.allSettled(traderStatePromises);
    traderStateResults.forEach((results, j) => {
      if (results.status !== "fulfilled") {
        log.error(
          {
            symbol,
            chunkIndex: j,
            error: results.reason instanceof Error ? results.reason.message : String(results.reason),
          },
          "multicall chunk failed"
        );
        return;
      }
      const addressChunk = addressChunks[j];
      results.value.forEach((result, k) => {
        if (!result.success) return;
        const account = proxy.interface.decodeFunctionResult("getTraderState", result.returnData)[0] as BigNumberish[];
        /**
         * 0 marginBalance : number; // current margin balance
         * 1 availableMargin : number; // amount over initial margin
         * 2 availableCashCC : number; // cash minus unpaid funding
         * 3 marginAccountCashCC : number;
         * 4 marginAccountPositionBC : number;
         * 5 marginAccountLockedInValueQC : number;
         * 6 fUnitAccumulatedFundingStart
         * 7 leverage
         * 8 fMarkPrice
         * 9 CollateralToQuoteConversion
         * 10 maintenance margin rate
         */
        const position: Position = {
          perpetualId: perpId,
          address: addressChunk[k],
          positionBC: ABK64x64ToFloat(BigInt(account[4])),
          cashCC: ABK64x64ToFloat(BigInt(account[3])),
          lockedInQC: ABK64x64ToFloat(BigInt(account[5])),
          unpaidFundingCC: ABK64x64ToFloat(BigInt(account[3]) - BigInt(account[2])),
          block: refreshBlock,
        };
        this.updatePosition(position);
      });
    });
    log.debug(
      { symbol, accounts: this.openPositions.get(symbol)?.size ?? 0, waitedMs: Date.now() - tsStart },
      "refreshed active accounts",
    );
  }

  private async refreshPrices(symbol: string) {
    if (Date.now() - (this.pricesFetchedAt.get(symbol) ?? 0) < this.config.fetchPricesIntervalSecondsMin * 1_000) {
      return true;
    }
    this.pricesFetchedAt.set(symbol, Date.now());
    try {
      const newPxSubmission = await this.md.fetchPricesForPerpetual(symbol);
      // if (!this.checkSubmissionsInSync(newPxSubmission.submission.timestamps)) {
      //   return false;
      // }
      this.pxSubmission.set(symbol, newPxSubmission);
    } catch (e) {
      log.error({ err: e }, "error fetching from price service");
      return false;
    }
    return true;
  }

  private async reconcileWatchlist(): Promise<void> {
    if (this.reconcileInflight) return this.reconcileInflight;
    this.lastReconcileAt = Date.now();
    this.reconcileInflight = (async () => {
      let info;
      try {
        await this.md.refreshSymbols(true);
        info = await this.md.exchangeInfo();
      } catch (e) {
        log.error(
          { error: e instanceof Error ? e.message : String(e) },
          "reconcile failed"
        );
        return;
      }
      const sdkStates: PerpStates = {};
      for (const pool of info.pools) {
        if (!pool.isRunning) continue;
        for (const p of pool.perpetuals) {
          sdkStates[`${p.baseCurrency}-${p.quoteCurrency}-${pool.poolSymbol}`] = p.state;
        }
      }
      const sdkPayload = serializePerpStates(sdkStates);
      let redisPayload: string | null = null;
      try {
        const redisStates = await loadWatchlist(this.redisPubClient, this.chainId);
        if (redisStates) redisPayload = serializePerpStates(redisStates);
      } catch (e) {
        log.error(
          { error: e instanceof Error ? e.message : String(e) },
          "reconcile: loadWatchlist failed"
        );
      }
      if (redisPayload === sdkPayload && this.lastPublishedWatchlist === sdkPayload) return;
      try {
        await publishWatchlist(this.redisPubClient, this.chainId, sdkPayload);
        this.lastPublishedWatchlist = sdkPayload;
      } catch (e) {
        log.error(
          { error: e instanceof Error ? e.message : String(e) },
          "reconcile: publish failed"
        );
        return;
      }
      const desired = Object.keys(sdkStates).filter((s) => sdkStates[s] === "NORMAL");
      const desiredSet = new Set(desired);
      const currentSet = new Set(this.symbols);
      for (const s of [...this.symbols]) if (!desiredSet.has(s)) this.dropSymbol(s);
      for (const s of desired) {
        if (currentSet.has(s)) continue;
        try {
          await this.addSymbol(s);
        } catch (e) {
          log.error(
            { symbol: s, error: e instanceof Error ? e.message : String(e) },
            "addSymbol failed"
          );
        }
      }
      log.info({ size: this.symbols.size }, "watchlist reconciled");
    })().finally(() => {
      this.reconcileInflight = null;
    });
    return this.reconcileInflight;
  }

  /**
   * Checks if any accounts can be liquidated and publishes them via redis.
   * No RPC calls are made here, only price service
   * @param symbol Perpetual symbol
   * @returns number of LiquidateTrader messages successfully published
   */
  private async checkPositions(symbol: string): Promise<number> {
    if (!(await this.refreshPrices(symbol))) return 0;
    const positions = this.openPositions.get(symbol);
    if (!positions) return 0;
    const curPx = this.pxSubmission.get(symbol)!;

    const candidates: string[] = [];
    for (const trader of positions.keys()) {
      if (!this.isMarginSafe(positions.get(trader)!, curPx)) candidates.push(trader);
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
        const msg = JSON.stringify({ chainId: this.chainId, symbol, traderAddr: trader });
        await this.redisPubClient.publish("LiquidateTrader", msg);
        perSymbol!.set(trader, now);
      }),
    );
    return dueTraders.length;
  }

  private logPosition(position: Position, pxS2S3: [number, number | undefined]) {
    const symbol = this.md.getSymbolFromPerpId(position.perpetualId)!;
    let S2 = pxS2S3[0];
    let Sm = S2 * (1 + (this.markPremium.get(symbol) ?? 0));
    // undefined -> either S3 = 1 (quote coll) or S3 = S2 (base coll)
    let S3 = pxS2S3[1] && !isNaN(pxS2S3[1]) ? pxS2S3[1] : this.isQuote.get(symbol) ? 1 : S2;
    let pos = position.positionBC;
    let lockedIn = position.lockedInQC;
    let cash = position.cashCC - position.unpaidFundingCC;
    let balance = cash + (pos * Sm - lockedIn) / S3;
    let leverage = (Math.abs(pos) * (Sm / S3)) / balance;
    log.debug({ pxS2SmS3: [S2, Sm, S3], symbol, balance, leverage, ...position }, "position margin");
  }

  private isMarginSafe(position: Position, px: IdxPriceInfo) {
    if (position.positionBC == 0 || px.s2MktClosed || px.s3MktClosed) {
      return true;
    }
    const symbol = this.md.getSymbolFromPerpId(position.perpetualId)!;
    let S2 = px.s2;
    let Sm = this.md.isPredictionMarket(symbol)
      ? px.ema + (this.markPremium.get(symbol) ?? 0)
      : S2 * (1 + (this.markPremium.get(symbol) ?? 0));
    // undefined -> either S3 = 1 (quote coll) or S3 = S2 (base coll)
    let S3 = px.s3 && !isNaN(px.s3) ? px.s3 : this.isQuote.get(symbol) ? 1 : S2;
    let pos = position.positionBC;
    let lockedIn = position.lockedInQC;
    let cash = position.cashCC - position.unpaidFundingCC;
    // pred mkt?
    if (this.md.isPredictionMarket(symbol)) {
      // Skip prediction markets for now
      const excessBalance = pmExcessBalance(pos, Sm, S3, lockedIn, cash, this.maintenanceRate.get(symbol)!);
      const isSafe = excessBalance >= 0;
      return isSafe;
    }
    // usual calculation
    let maintenanceMargin = ((Math.abs(pos) * Sm) / S3) * this.maintenanceRate.get(symbol)!;
    let balance = cash + (pos * Sm - lockedIn) / S3;
    return balance >= maintenanceMargin;
  }

  /**
   * Check that max(t) - min (t) <= threshold
   * @param timestamps Array of timestamps
   * @returns True if the timestamps are sufficiently close to each other
   */
  private checkSubmissionsInSync(timestamps: number[]): boolean {
    let gap = Math.max(...timestamps) - Math.min(...timestamps);
    if (gap > this.MAX_OUTOFSYNC_SECONDS) {
      return false;
    }
    return true;
  }
}
