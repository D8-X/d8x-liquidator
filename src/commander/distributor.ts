import {
  MarketData,
  PerpetualDataHandler,
  PriceFeedSubmission,
  ABK64x64ToFloat,
  COLLATERAL_CURRENCY_QUOTE,
  Multicall3__factory,
  MULTICALL_ADDRESS,
  Multicall3,
} from "@d8x/perpetuals-sdk";
import { providers } from "ethers";
import { Redis } from "ioredis";
import { constructRedis } from "../utils";
import {
  LiquidatorConfig,
  Position,
  UpdateMarginAccountMsg,
  UpdateMarkPriceMsg,
  UpdateUnitAccumulatedFundingMsg,
} from "../types";
import { PerpStorage } from "@d8x/perpetuals-sdk/dist/esm/contracts/IPerpetualManager";

export default class Distributor {
  // objects
  private md: MarketData;
  private redisSubClient: Redis;
  private redisPubClient: Redis;
  private providers: providers.StaticJsonRpcProvider[];

  // state
  private lastRefreshTime: Map<string, number> = new Map();
  private openPositions: Map<string, Map<string, Position>> = new Map();
  private pxSubmission: Map<string, { submission: PriceFeedSubmission; pxS2S3: [number, number] }> = new Map();
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

  // constants

  // publish times must be within 10 seconds of each other, or submission will fail on-chain
  private MAX_OUTOFSYNC_SECONDS: number = 10;

  constructor(config: LiquidatorConfig) {
    this.config = config;
    this.redisSubClient = constructRedis("commanderSubClient");
    this.redisPubClient = constructRedis("commanderPubClient");
    this.providers = this.config.rpcWatch.map((url) => new providers.StaticJsonRpcProvider(url));
    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(config.sdkConfig));
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
      this.pxSubmission.set(symbol, await this.md.fetchPriceSubmissionInfoForPerpetual(symbol));
      // mark premium, accumulated funding per BC unit
      const perpState = await this.md.getReadOnlyProxyInstance().getPerpetual(this.md.getPerpIdFromSymbol(symbol));
      this.markPremium.set(symbol, ABK64x64ToFloat(perpState.currentMarkPremiumRate.fPrice));
      this.unitAccumulatedFunding.set(symbol, ABK64x64ToFloat(perpState.fUnitAccumulatedFunding));
      // "preallocate" trader set
      this.openPositions.set(symbol, new Map());
      // dummy values
      this.lastRefreshTime.set(symbol, 0);
    }

    // Subscribe to blockchain events
    // console.log(`${new Date(Date.now()).toISOString()}: subscribing to blockchain event streamer...`);
    await this.redisSubClient.subscribe(
      "block",
      "UpdateMarkPriceEvent",
      "UpdateMarginAccountEvent",
      "UpdateUnitAccumulatedFundingEvent",
      (err, count) => {
        if (err) {
          console.log(`${new Date(Date.now()).toISOString()}: redis subscription failed: ${err}`);
          process.exit(1);
        }
        // else {
        //   console.log(`${new Date(Date.now()).toISOString()}: redis subscription success - ${count} active channels`);
        // }
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
            this.updatePosition({
              address: account.traderAddr,
              perpetualId: account.perpetualId,
              positionBC: account.positionBC,
              cashCC: account.cashCC,
              lockedInQC: account.lockedInQC,
              unpaidFundingCC: 0,
            });
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
        }
      });
      await this.refreshAllAccounts();
    });
  }

  private updatePosition(position: Position) {
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

  private async refreshAllAccounts() {
    await Promise.allSettled(this.symbols.map((symbol) => this.refreshActiveAccounts(symbol)));
  }

  /**
   * Reset active accounts array
   */
  public async refreshActiveAccounts(symbol: string) {
    this.requireReady();
    if (Date.now() - (this.lastRefreshTime.get(symbol) ?? 0) < this.config.refreshAccountsIntervalSecondsMin * 1_000) {
      return;
    }
    const chunkSize1 = 2 ** 16; // for addresses
    const chunkSize2 = 2 ** 8; // for margin accounts
    const perpId = this.md.getPerpIdFromSymbol(symbol)!;
    const proxy = this.md.getReadOnlyProxyInstance();
    const rpcProviders = this.config.rpcWatch.map((url) => new providers.StaticJsonRpcProvider(url));
    let providerIdx = Math.floor(Math.random() * rpcProviders.length);
    this.lastRefreshTime.set(symbol, Date.now());

    let tsStart: number;
    console.log(`${symbol}: fetching number of accounts ... `);
    tsStart = Date.now();

    const numAccounts = (await proxy.countActivePerpAccounts(perpId)).toNumber();
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
    // console.log({
    //   symbol: symbol,
    //   time: new Date(Date.now()).toISOString(),
    //   addresses: addresses.size,
    //   waited: `${Date.now() - tsStart} ms`,
    // });

    // fech accounts
    const promises2: Promise<Multicall3.ResultStructOutput[]>[] = [];
    const addressChunks: string[][] = [];
    const multicall = Multicall3__factory.connect(MULTICALL_ADDRESS, rpcProviders[providerIdx]);
    const traderList = [...addresses];
    for (let i = 0; i < traderList.length; i += chunkSize2) {
      const addressChunk = traderList.slice(i, i + chunkSize2);
      const calls: Multicall3.Call3Struct[] = addressChunk.map((addr) => ({
        allowFailure: true,
        target: proxy.address,
        callData: proxy.interface.encodeFunctionData("getMarginAccount", [perpId, addr]),
      }));
      promises2.push(multicall.connect(rpcProviders[providerIdx]).callStatic.aggregate3(calls));
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
                  "getMarginAccount",
                  result.returnData
                )[0] as PerpStorage.MarginAccountStructOutput;
                const position: Position = {
                  perpetualId: perpId,
                  address: addressChunk[k],
                  positionBC: ABK64x64ToFloat(account.fPositionBC),
                  cashCC: ABK64x64ToFloat(account.fCashCC),
                  lockedInQC: ABK64x64ToFloat(account.fLockedInValueQC),
                  unpaidFundingCC: 0,
                };
                position.unpaidFundingCC =
                  position.positionBC *
                  (this.unitAccumulatedFunding.get(symbol)! - ABK64x64ToFloat(account.fUnitAccumulatedFundingStart));
                this.updatePosition(position);
              }
            });
          }
        });
      } catch (e) {
        console.log("Error fetching account chunk (RPC?)");
      }
    }
    console.log({
      symbol: symbol,
      time: new Date(Date.now()).toISOString(),
      accounts: this.openPositions.get(symbol)!.size,
      waited: `${Date.now() - tsStart} ms`,
    });
  }

  /**
   * Checks if any accounts can be liquidated and publishes them via redis.
   * No RPC calls are made here, only price service
   * @param symbol Perpetual symbol
   * @returns number of accounts that can be liquidated
   */
  private async checkPositions(symbol: string) {
    this.requireReady();
    if (Date.now() - (this.pricesFetchedAt.get(symbol) ?? 0) < this.config.fetchPricesIntervalSecondsMin * 1_000) {
      return undefined;
    }
    try {
      const newPxSubmission = await this.md.fetchPriceSubmissionInfoForPerpetual(symbol);
      if (!this.checkSubmissionsInSync(newPxSubmission.submission.timestamps)) {
        return false;
      }
      this.pxSubmission.set(symbol, newPxSubmission);
    } catch (e) {
      console.log("error fetching from price service:");
      console.log(e);
      return false;
    }
    const positions = this.openPositions.get(symbol)!;
    const curPx = this.pxSubmission.get(symbol)!;
    const accountsSent: Set<string> = new Set();

    for (const trader of positions.keys()) {
      const position = positions.get(trader)!;
      if (!this.isMarginSafe(position, curPx.pxS2S3)) {
        const msg = JSON.stringify({
          symbol: symbol,
          traderAddr: trader,
        });
        if (Date.now() - (this.messageSentAt.get(msg) ?? 0) > this.config.liquidateIntervalSecondsMin * 1_000) {
          await this.redisPubClient.publish("LiquidateTrader", msg);
          this.messageSentAt.set(msg, Date.now());
        }
        accountsSent.add(msg);
      }
    }
    return accountsSent.size > 0;
  }

  private isMarginSafe(position: Position, pxS2S3: [number, number | undefined]) {
    if (position.positionBC == 0) {
      return true;
    }
    const symbol = this.md.getSymbolFromPerpId(position.perpetualId)!;
    let S2 = pxS2S3[0];
    let Sm = S2 * (1 + this.markPremium.get(symbol)!);
    // undefined -> either S3 = 1 (quote coll) or S3 = S2 (base coll)
    let S3 = pxS2S3[1] ?? (this.isQuote.get(symbol) ? 1 : S2);
    let pos = position.positionBC;
    let lockedIn = position.lockedInQC;
    let cash = position.cashCC - position.unpaidFundingCC;
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
