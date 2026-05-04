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

export default class Distributor {
  // objects
  private md: MarketData;
  private redisSubClient: Redis;
  private redisPubClient: Redis;

  /**
   * There will be only 1 instance of provider in this array. Historically we
   * used a list of JsonRpcProvider's, therefore we have array here until we
   * cleanup.
   *
   * Use this.config.rpcWatch for distributor providers.
   */
  private providers: MultiUrlJsonRpcProvider[];

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
    this.providers = [
      new MultiUrlJsonRpcProvider(this.config.rpcWatch, this.md.network, {
        timeoutSeconds: 25,
        logErrors: true,
        logRpcSwitches: true,
        // Distributor uses free rpcs, make sure to switch on each call.
        switchRpcOnEachRequest: true,
        staticNetwork: true,
      }),
    ];
  }

  /**
   * Connects to the blockchain choosing a random RPC.
   * If none of the RPCs work, it sleeps before crashing.
   */
  public async initialize() {
    // RPC URL randomization happens at config load time using the `shuffle()` in
    // utils.loadConfig, `this.config.rpcWatch` is already a shuffled list by
    // the time it reaches the MultiUrlJsonRpcProvider constructor
    let success = false;
    let i = 0;
    while (!success && i < this.providers.length) {
      const results = (await Promise.allSettled([this.md.createProxyInstance(this.providers[i])]))[0];
      success = results.status === "fulfilled";
      i++;
    }
    if (!success) {
      throw new Error(`commander: all RPCs are down (${this.config.rpcWatch.join(", ")})`);
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
          console.log(`${new Date(Date.now()).toISOString()}: redis subscription failed: ${err}`);
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
      console.log({
        info: "addSymbol: skipping - price fetch failed after retries",
        time: new Date().toISOString(),
        symbol,
        error: lastErr instanceof Error ? lastErr.message : String(lastErr),
      });
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
      console.log(
        `${new Date(Date.now()).toISOString()}: failed to publish SDK state: ${
          e instanceof Error ? e.stack ?? e.message : String(e)
        }`,
      );
    }
  }

  private async broadcastWatchlist(): Promise<void> {
    let info;
    try {
      info = await this.md.exchangeInfo();
    } catch (e) {
      console.log({
        info: "broadcastWatchlist: exchangeInfo failed",
        error: e instanceof Error ? e.message : String(e),
      });
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
      console.log(
        `${new Date(Date.now()).toISOString()}: failed to publish watchlist: ${
          e instanceof Error ? e.stack ?? e.message : String(e)
        }`,
      );
    }
  }

  private requireReady() {
    if (!this.ready) {
      throw new Error("not ready: await distributor.initialize()");
    }
  }

  private async onPerpEmergency(msg: PerpEmergencyMsg): Promise<void> {
    if (!this.dropSymbol(msg.symbol)) return;
    console.log({ info: "perp dropped", time: new Date().toISOString(), ...msg });
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
            this.checkPositions(symbol);
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
          if (account.traderAddr.toLowerCase() == this.md.getProxyAddress().toLowerCase()) {
            return;
          }
          void (async () => {
            const pos = await this.fetchPosition(account.perpetualId, account.traderAddr, account.block);
            await this.updatePosition(pos);
          })();
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
          const pos = await this.fetchPosition(perpetualId, traderAddr, block);
          await this.updatePosition(pos);
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
            console.log({
              message: "Refreshing all active accounts due to sentinel error",
              time: new Date(Date.now()).toISOString(),
              lastRefreshOfAllOpenOrders: this.lastRefreshOfAllActiveAccounts.toISOString(),
              sentinelReason: channel,
            });
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
    perSymbol.set(position.address, position);
  }

  private async fetchPosition(perpetualId: number, address: string, blockTag: number): Promise<Position> {
    const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
    const pxSubmission = this.pxSubmission.get(symbol)!;
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
      console.log("[refreshActiveAccounts] called too soon", {
        symbol: symbol,
        time: new Date(Date.now()).toISOString(),
        lastRefresh: new Date(this.lastRefreshTime.get(symbol) ?? 0),
      });
      return;
    }
    const chunkSize1 = 2 ** 16; // for addresses
    const chunkSize2 = 2 ** 8; // for margin accounts
    const perpId = this.md.getPerpIdFromSymbol(symbol)!;
    const proxy = this.md.getReadOnlyProxyInstance() as any as IPerpetualManager;
    const rpcProviders = this.providers;
    let providerIdx = Math.floor(Math.random() * rpcProviders.length);
    this.lastRefreshTime.set(symbol, Date.now());
    const refreshBlock = await rpcProviders[providerIdx].getBlockNumber();

    let tsStart: number;
    console.log(`${symbol}: fetching number of accounts ... `);
    tsStart = Date.now();

    const numAccounts = Number(await proxy.countActivePerpAccounts(perpId));
    console.log({ symbol: symbol, time: new Date(Date.now()).toISOString(), activeAccounts: numAccounts });

    // fetch addresses
    const promises: Promise<string[]>[] = [];
    for (let i = 0; i < numAccounts; i += chunkSize1) {
      promises.push(proxy.connect(rpcProviders[providerIdx]).getActivePerpAccountsByChunks(perpId, i, i + chunkSize1));
      providerIdx = (providerIdx + 1) % rpcProviders.length;
    }
    let addresses: Set<string> = new Set();
    for (let i = 0; i < promises.length; i += rpcProviders.length) {
      try {
        tsStart = Date.now();
        const chunks = await Promise.allSettled(promises.slice(i, i + rpcProviders.length));
        for (const result of chunks) {
          if (result.status === "fulfilled") {
            result.value.map((addr) => addresses.add(addr));
          }
        }
      } catch (e) {
        console.log(`${symbol} ${new Date(Date.now()).toISOString()}: error`);
      }
    }

    // fech accounts
    const promises2: Promise<Multicall3.ResultStructOutput[]>[] = [];
    const addressChunks: string[][] = [];
    const multicall = Multicall3__factory.connect(MULTICALL_ADDRESS, rpcProviders[providerIdx]);
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
      promises2.push(multicall.connect(rpcProviders[providerIdx]).aggregate3.staticCall(calls));
      addressChunks.push(addressChunk);
      providerIdx = (providerIdx + 1) % rpcProviders.length;
    }

    tsStart = Date.now();
    for (let i = 0; i < promises2.length; i += rpcProviders.length) {
      try {
        const addressChunkBin = addressChunks.slice(i, i + rpcProviders.length);
        const accountChunk = await Promise.allSettled(promises2.slice(i, i + rpcProviders.length));

        accountChunk.map((results, j) => {
          if (results.status === "fulfilled") {
            const addressChunk = addressChunkBin[j];
            results.value.map((result, k) => {
              if (result.success) {
                const account = proxy.interface.decodeFunctionResult(
                  "getTraderState",
                  result.returnData,
                )[0] as BigNumberish[];
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
              }
            });
          }
        });
      } catch (e) {
        console.log("Error fetching account chunk (RPC?)", e);
      }
    }
    console.log({
      symbol: symbol,
      time: new Date(Date.now()).toISOString(),
      accounts: this.openPositions.get(symbol)!.size,
      waited: `${Date.now() - tsStart} ms`,
    });
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
      console.log("error fetching from price service:");
      console.log(e);
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
        console.log({ info: "reconcile failed", error: e instanceof Error ? e.message : String(e) });
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
        console.log({ info: "reconcile: loadWatchlist failed", error: e instanceof Error ? e.message : String(e) });
      }
      if (redisPayload === sdkPayload && this.lastPublishedWatchlist === sdkPayload) return;
      try {
        await publishWatchlist(this.redisPubClient, this.chainId, sdkPayload);
        this.lastPublishedWatchlist = sdkPayload;
      } catch (e) {
        console.log({ info: "reconcile: publish failed", error: e instanceof Error ? e.message : String(e) });
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
          console.log({ info: "addSymbol failed", symbol: s, error: e instanceof Error ? e.message : String(e) });
        }
      }
      console.log({ info: "watchlist reconciled", size: this.symbols.size });
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
    const positions = this.openPositions.get(symbol)!;
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
    console.log({
      time: new Date(Date.now()).toISOString(),
      pxS2SmS3: [S2, Sm, S3],
      symbol: symbol,
      balance: balance,
      leverage: leverage,
      ...position,
    });
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
      // if (!isSafe) {
      //   console.log({
      //     info: "Prediction market liquidation would occur, ignoring for now",
      //     position,
      //     excessBalance,
      //     pmExcessBalanceParams: [pos, Sm, S3, lockedIn, cash, this.maintenanceRate.get(symbol)],
      //   });
      // }
      // // Return true to skip prediction markets for now
      // return true;
      return isSafe;
    }
    // usual calculation
    let maintenanceMargin = ((Math.abs(pos) * Sm) / S3) * this.maintenanceRate.get(symbol)!;
    let balance = cash + (pos * Sm - lockedIn) / S3;
    // if (balance < maintenanceMargin) {
    //   console.log({
    //     trader: position.address,
    //     symbol: symbol,
    //     cash: cash,
    //     balance: balance,
    //     leverage: Math.abs(balance) > 1e-12 ? (Math.abs(pos) * Sm) / S3 / balance : -Infinity,
    //   });
    // }
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
