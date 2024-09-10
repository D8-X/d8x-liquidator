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
} from "@d8x/perpetuals-sdk";
import { BigNumberish } from "ethers";
import { Redis } from "ioredis";
import { constructRedis } from "../utils";
import {
  LiquidateMsg,
  LiquidateTraderMsg,
  LiquidatorConfig,
  Position,
  UpdateMarginAccountMsg,
  UpdateMarkPriceMsg,
  UpdateUnitAccumulatedFundingMsg,
} from "../types";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider";

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
  private lastFundingFetchTime: Map<string, number> = new Map();
  private openPositions: Map<string, Map<string, Position>> = new Map();
  private pxSubmission: Map<string, IdxPriceInfo> = new Map();
  private markPremium: Map<string, number> = new Map();
  private unitAccumulatedFunding: Map<string, number> = new Map();
  private messageSentAt: Map<string, number> = new Map();
  private pricesFetchedAt: Map<string, number> = new Map();
  public ready: boolean = false;

  // static info
  private config: LiquidatorConfig;
  private isQuote: Map<string, boolean> = new Map();
  private symbols: string[] = [];
  private maintenanceRate: Map<string, number> = new Map();

  // publish times must be within 10 seconds of each other, or submission will fail on-chain
  private MAX_OUTOFSYNC_SECONDS: number = 10;

  // Last time refreshAllActiveAccounts was called
  public lastRefreshOfAllActiveAccounts: Date = new Date(0);

  constructor(config: LiquidatorConfig) {
    this.config = config;
    this.redisSubClient = constructRedis("commanderSubClient");
    this.redisPubClient = constructRedis("commanderPubClient");

    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(config.sdkConfig));
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
    // Create a proxy instance to access the blockchain
    let success = false;
    let i = 0;
    this.providers = this.providers.sort(() => Math.random() - 0.5);
    while (!success && i < this.providers.length) {
      const results = (await Promise.allSettled([this.md.createProxyInstance(this.providers[i])]))[0];
      success = results.status === "fulfilled";
      i++;
    }
    if (!success) {
      console.log(`${new Date(Date.now()).toISOString()}: all rpcs are down ${this.config.rpcWatch.join(", ")}`);
    }

    const info = await this.md.exchangeInfo();

    this.symbols = info.pools
      .map((pool) =>
        pool.perpetuals.map((perpetual) => `${perpetual.baseCurrency}-${perpetual.quoteCurrency}-${pool.poolSymbol}`)
      )
      .flat();

    for (const symbol of this.symbols) {
      // static info
      this.maintenanceRate.set(symbol, this.md.getPerpetualStaticInfo(symbol).maintenanceMarginRate);
      this.isQuote.set(
        symbol,
        this.md.getPerpetualStaticInfo(symbol).collateralCurrencyType == COLLATERAL_CURRENCY_QUOTE
      );
      // price info
      try {
        const priceInfo = await this.md.fetchPricesForPerpetual(symbol);

        this.pxSubmission.set(symbol, priceInfo);
      } catch (e) {
        this.pxSubmission.set(symbol, {
          s2: 1,
          ema: 1,
          s2MktClosed: true,
          conf: 1n,
          predMktCLOBParams: 1n,
        });
      }
      // mark premium, accumulated funding per BC unit
      const perpState = await this.md.getReadOnlyProxyInstance().getPerpetual(this.md.getPerpIdFromSymbol(symbol));
      this.markPremium.set(symbol, ABK64x64ToFloat(perpState.currentMarkPremiumRate.fPrice));
      this.unitAccumulatedFunding.set(symbol, ABK64x64ToFloat(perpState.fUnitAccumulatedFunding));
      // "preallocate" trader set
      this.openPositions.set(symbol, new Map());
      // dummy values
      this.lastRefreshTime.set(symbol, 0);
      console.log({
        symbol: symbol,
        markPremium: this.markPremium.get(symbol),
        unitAccumulatedFunding: this.unitAccumulatedFunding.get(symbol),
      });
    }

    // Subscribe to blockchain events
    await this.redisSubClient.subscribe(
      "block",
      "UpdateMarkPriceEvent",
      "UpdateMarginAccountEvent",
      "LiquidateEvent",
      "listener-error",
      "switch-mode",
      (err, count) => {
        if (err) {
          console.log(`${new Date(Date.now()).toISOString()}: redis subscription failed: ${err}`);
          process.exit(1);
        }
      }
    );

    this.ready = true;
  }

  private requireReady() {
    if (!this.ready) {
      throw new Error("not ready: await distributor.initialize()");
    }
  }

  /**
   * Listen to events for a number of blocks; requires initialize() first
   * @param maxBlocks number of blocks we will listen to event handlers
   * @returns void
   */
  public async run(): Promise<void> {
    this.requireReady();
    return new Promise<void>(async (resolve, reject) => {
      // fetch all accounts
      setInterval(async () => {
        if (
          Date.now() - Math.min(...this.lastRefreshTime.values()) <
          this.config.refreshAccountsIntervalSecondsMax * 1_000
        ) {
          return;
        }
        await this.refreshAllAccounts();
      }, 10_000);

      // fetch accumulated funding so that it's fresh often enough
      setInterval(async () => {
        await this.refreshUnitAccumulatedFunding();
      }, 10_000);

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
            await this.fetchPosition(account.perpetualId, account.traderAddr).then((pos) => {
              this.updatePosition(pos);
            });
            break;
          }

          case "UpdateMarkPriceEvent": {
            const { symbol, markPremium }: UpdateMarkPriceMsg = JSON.parse(msg);
            this.markPremium.set(symbol, markPremium);
            break;
          }

          case "UpdateUnitAccumulatedFundingEvent": {
            const { symbol, unitAccumulatedFundingCC }: UpdateUnitAccumulatedFundingMsg = JSON.parse(msg);
            this.unitAccumulatedFunding.set(symbol, unitAccumulatedFundingCC);
            break;
          }

          case "LiquidateEvent": {
            const { perpetualId, traderAddr }: LiquidateMsg = JSON.parse(msg);
            await this.fetchPosition(perpetualId, traderAddr).then((pos) => {
              this.updatePosition(pos);
            });
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
    });
  }

  private async updatePosition(position: Position) {
    const symbol = this.md.getSymbolFromPerpId(position.perpetualId)!;
    if (!this.openPositions.has(symbol)) {
      this.openPositions.set(symbol, new Map());
    }
    if (position.positionBC !== 0) {
      this.openPositions.get(symbol)!.set(position.address, position);
    } else {
      this.openPositions.get(symbol)!.delete(position.address);
    }
  }

  private async fetchPosition(perpetualId: number, address: string) {
    const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
    const pxSubmission = this.pxSubmission.get(symbol)!;
    const account = await this.md
      .getReadOnlyProxyInstance()
      .getTraderState(perpetualId, address, [floatToABK64x64(pxSubmission.s2), floatToABK64x64(pxSubmission.s3 ?? 0)]);

    const position: Position = {
      perpetualId: perpetualId,
      address: address,
      positionBC: ABK64x64ToFloat(BigInt(account[4])),
      cashCC: ABK64x64ToFloat(BigInt(account[3])),
      lockedInQC: ABK64x64ToFloat(BigInt(account[5])),
      unpaidFundingCC: ABK64x64ToFloat(BigInt(account[3]) - BigInt(account[2])),
    };
    return position;
  }

  private async refreshUnitAccumulatedFunding() {
    for (const symbol of this.symbols) {
      if (Date.now() - (this.lastFundingFetchTime.get(symbol) ?? 0) < this.config.liquidateIntervalSecondsMax * 1_000) {
        return;
      }
      this.lastFundingFetchTime.set(symbol, Date.now());
      const perp = await this.md.getReadOnlyProxyInstance().getPerpetual(this.md.getPerpIdFromSymbol(symbol)!);
      this.unitAccumulatedFunding.set(symbol, ABK64x64ToFloat(perp.fUnitAccumulatedFunding));
    }
  }

  private async refreshAllAccounts() {
    this.lastRefreshOfAllActiveAccounts = new Date();
    await Promise.allSettled(this.symbols.map((symbol) => this.refreshActiveAccounts(symbol)));
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
          [floatToABK64x64(pxSubmission.s2), floatToABK64x64(pxSubmission.s3 ?? 0)],
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
                  result.returnData
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

  /**
   * Checks if any accounts can be liquidated and publishes them via redis.
   * No RPC calls are made here, only price service
   * @param symbol Perpetual symbol
   * @returns number of accounts that can be liquidated
   */
  private async checkPositions(symbol: string) {
    this.requireReady();

    if (!(await this.refreshPrices(symbol))) {
      return false;
    }
    const positions = this.openPositions.get(symbol)!;
    const curPx = this.pxSubmission.get(symbol)!;
    const accountsSent: Set<string> = new Set();

    for (const trader of positions.keys()) {
      const position = positions.get(trader)!;
      if (!this.isMarginSafe(position, curPx)) {
        const msg = JSON.stringify({
          symbol: symbol,
          traderAddr: trader,
        });
        if (Date.now() - (this.messageSentAt.get(msg) ?? 0) > this.config.liquidateIntervalSecondsMin * 1_000) {
          this.logPosition(position, [curPx.s2, curPx.s3]);
          await this.redisPubClient.publish("LiquidateTrader", msg);
          this.messageSentAt.set(msg, Date.now());
        }
        accountsSent.add(msg);
      }
    }
    return accountsSent.size > 0;
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
    if (position.positionBC == 0) {
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
