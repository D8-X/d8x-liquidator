import {
  MarketData,
  PerpetualDataHandler,
  LiquidatorTool,
  MarginAccount,
  PriceFeedSubmission,
  BUY_SIDE,
  CLOSED_SIDE,
  ABK64x64ToFloat,
  COLLATERAL_CURRENCY_QUOTE,
  GasInfo,
  GasPriceV2,
  Multicall3__factory,
  MULTICALL_ADDRESS,
  Multicall3,
} from "@d8x/perpetuals-sdk";
import { BigNumber, ethers } from "ethers";
import { providers } from "ethers";
import { Redis } from "ioredis";
import { constructRedis } from "../utils";
import {
  LiquidatorConfig,
  ListenerConfig,
  Position,
  TradeMsg,
  UpdateMarginAccountMsg,
  UpdateMarkPriceMsg,
  ZERO_POSITION,
} from "../types";
import { Result } from "@ethersproject/abi/lib/interface";
import { PerpStorage } from "@d8x/perpetuals-sdk/dist/esm/contracts/IPerpetualManager";

export default class PositionManager {
  // objects
  private mktData: MarketData | undefined;
  private liqTool: LiquidatorTool[] | undefined;
  private redisSubClient: Redis;
  private redisPubClient: Redis;

  // parameters
  private symbols: string[] = [];
  private maintenanceRate: Map<string, number> = new Map();

  // state
  private openPositions: Map<string, Map<string, Position>> = new Map();
  private addressUpdate: Map<string, Set<string>> = new Map();
  private addressWatch: Map<string, Set<string>> = new Map();
  private addressAdd: Map<string, Set<string>> = new Map();

  private config: ListenerConfig;
  private pxSubmission: Map<string, { submission: PriceFeedSubmission; pxS2S3: [number, number] }> = new Map();
  private markPremium: Map<string, number> = new Map();
  private isQuote: Map<string, boolean> = new Map();
  private lastRefreshTime: number = Infinity;

  // constants
  private MIN_BLOCKTIME_SECONDS: number = 2;
  private MAX_REFRESH_INTERVAL_MS: number = 60 * 60 * 1_000;
  private MIN_REFRESH_INTERVAL_MS: number = 10_000;
  private LIQUIDATE_TOPIC = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Liquidate(uint24,address,address,bytes16,int128,int128,int128)")
  );
  // private treasuryAddr: string;

  // private moduloTS: number;
  // private residualTS: number;
  // private LIQUIDATE_INTERVAL_MS: number;
  // private peerNonExecutionTimestampMS: Map<string, number>;
  private blockNumber: number | undefined;
  // private lastLiquidateCall: number = 0;
  // private hasQueue: boolean = false;

  constructor(config: ListenerConfig) {
    this.config = config;
    // this.LIQUIDATE_INTERVAL_MS = this.config.liquidateIntervalSeconds * 1_000;
    // this.REFRESH_INTERVAL_MS = this.config.refreshAccountsSeconds * 1_000;
    // this.MIN_REFRESH_INTERVAL_MS
    // this.peerNonExecutionTimestampMS = new Map<string, number>();
    this.redisSubClient = constructRedis("LiquidatorListener");
    this.redisPubClient = constructRedis("LiquidatorStreamer");
  }

  /**
   *
   * @param provider Provider - used to query open positions and execute liquidations
   */
  public async initialize(rpcUrl: string) {
    const provider = new providers.StaticJsonRpcProvider(rpcUrl);
    const config = PerpetualDataHandler.readSDKConfig(this.config.sdkConfig);
    const md = new MarketData(config);
    this.mktData = md;

    // Create a proxy instance to access the blockchain
    await this.mktData.createProxyInstance(provider);
    const info = await this.mktData.exchangeInfo({ rpcURL: rpcUrl });

    this.symbols = info.pools
      .map((pool) =>
        pool.perpetuals.map((perpetual) => `${perpetual.baseCurrency}-${perpetual.quoteCurrency}-${pool.poolSymbol}`)
      )
      .flat();

    for (const symbol of this.symbols) {
      this.maintenanceRate.set(symbol, md.getPerpetualStaticInfo(symbol).maintenanceMarginRate);
      this.isQuote.set(symbol, md.getPerpetualStaticInfo(symbol).collateralCurrencyType == COLLATERAL_CURRENCY_QUOTE);
      this.pxSubmission.set(symbol, await this.mktData.fetchPriceSubmissionInfoForPerpetual(symbol));
      const perpState = await this.mktData.getPerpetualState(symbol);
      this.markPremium.set(symbol, perpState.markPrice / perpState.indexPrice - 1);
      this.openPositions.set(symbol, new Map());
      this.addressAdd.set(symbol, new Set());
      this.addressUpdate.set(symbol, new Set());
      this.addressWatch.set(symbol, new Set());
    }

    // Subscribe to blockchain events
    console.log(`${new Date(Date.now()).toISOString()}: subscribing to blockchain event streamer...`);
    await this.redisSubClient.subscribe(
      "block",
      "Liquidate",
      "Trade",
      "UpdateMarkPrice",
      "UpdateMarginAccount",
      (err, count) => {
        if (err) {
          console.log(`${new Date(Date.now()).toISOString()}: redis subscription failed: ${err}`);
          process.exit(1);
        } else {
          console.log(`${new Date(Date.now()).toISOString()}: redis subscription success - ${count} active channels`);
        }
      }
    );
  }

  /**
   * Listen to events for a number of blocks; requires initialize() first
   * @param maxBlocks number of blocks we will listen to event handlers
   * @returns void
   */
  public async run(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // fetch all accounts
      setInterval(async () => {
        if (Date.now() - this.lastRefreshTime < this.MAX_REFRESH_INTERVAL_MS) {
          return;
        }
        await Promise.allSettled(this.symbols.map((symbol) => this.refreshActiveAccounts(symbol)));
      }, 10_000);

      this.redisSubClient.on("message", async (channel, msg) => {
        switch (channel) {
          case "block": {
            for (const symbol of this.symbols) {
              this.checkPositions(symbol);
            }
            break;
          }

          case "UpdateMarginAccount": {
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

          case "UpdateMarkPrice": {
            const { perpetualId, markPremium }: UpdateMarkPriceMsg = JSON.parse(msg);
            this.markPremium.set(this.mktData!.getSymbolFromPerpId(perpetualId)!, markPremium);
            break;
          }
        }
      });
    });
  }

  private updatePosition(position: Position) {
    const symbol = this.mktData?.getSymbolFromPerpId(position.perpetualId)!;
    if (!this.openPositions.has(symbol)) {
      this.openPositions.set(symbol, new Map());
    }
    if (position.positionBC !== 0) {
      this.openPositions.get(symbol)!.set(position.address, position);
    } else {
      this.openPositions.get(symbol)!.delete(position.address);
    }
  }

  /**
   * Reset active accounts array
   */
  public async refreshActiveAccounts(symbol: string) {
    if (Date.now() - this.lastRefreshTime < this.MIN_REFRESH_INTERVAL_MS) {
      return;
    }
    const chunkSize1 = 5_000; // for addresses
    const chunkSize2 = 500; // for margin accounts
    const perpId = this.mktData!.getPerpIdFromSymbol(symbol)!;
    const proxy = this.mktData!.getReadOnlyProxyInstance();

    const rpcProviders = this.config.httpRPC.map((url) => new providers.StaticJsonRpcProvider(url));
    let providerIdx = Math.floor(Math.random() * rpcProviders.length);

    this.lastRefreshTime = Date.now();
    const numAccounts = (await proxy.countActivePerpAccounts(perpId)).toNumber();

    console.log(`${symbol} ${new Date(Date.now()).toISOString()}: There are ${numAccounts} active accounts`);

    // fetch addresses
    const promises: Promise<string[]>[] = [];
    for (let i = 0; i < numAccounts; i += chunkSize1) {
      promises.push(proxy.connect(rpcProviders[providerIdx]).getActivePerpAccountsByChunks(perpId, i, i + chunkSize1));
      providerIdx = (providerIdx + 1) % rpcProviders.length;
    }
    let addresses: string[] = [];
    for (let i = 0; i < promises.length; i += rpcProviders.length) {
      try {
        const chunks = await Promise.allSettled(promises.slice(i, i + rpcProviders.length));
        for (const result of chunks) {
          if (result.status === "fulfilled") {
            addresses = addresses.concat(result.value);
          }
        }
      } catch (e) {
        console.log("Error fetching address chunk (RPC)");
      }
    }

    // fech accounts
    const promises2: Promise<Multicall3.ResultStructOutput[]>[] = [];
    const addressChunks: string[][] = [];
    const multicall = Multicall3__factory.connect(MULTICALL_ADDRESS, rpcProviders[providerIdx]);
    for (let i = 0; i < addresses.length; i += chunkSize2) {
      const addressChunk = addresses.slice(i, i + chunkSize2);
      const calls: Multicall3.Call3Struct[] = addressChunk.map((addr) => ({
        allowFailure: true,
        target: proxy.address,
        callData: proxy.interface.encodeFunctionData("getMarginAccount", [perpId, addr]),
      }));
      promises2.push(multicall.connect(rpcProviders[providerIdx]).callStatic.aggregate3(calls));
      addressChunks.push(addressChunk);
      providerIdx = (providerIdx + 1) % rpcProviders.length;
    }

    for (let i = 0; i < promises2.length; i += rpcProviders.length) {
      try {
        const addressChunk = addressChunks.slice(i, i + rpcProviders.length).flat();
        const accountChunk = (await Promise.allSettled(promises2.slice(i, i + rpcProviders.length))).flat();

        accountChunk.map((results, j) => {
          if (results.status === "fulfilled") {
            results.value.map((result) => {
              if (result.success) {
                const account = proxy.interface.decodeFunctionResult(
                  "getMarginAccount",
                  result.returnData
                )[0] as PerpStorage.MarginAccountStructOutput;
                const position: Position = {
                  perpetualId: perpId,
                  address: addressChunk[j],
                  positionBC: ABK64x64ToFloat(account.fPositionBC),
                  cashCC: ABK64x64ToFloat(account.fCashCC),
                  lockedInQC: ABK64x64ToFloat(account.fLockedInValueQC),
                  unpaidFundingCC: ABK64x64ToFloat(account.fUnitAccumulatedFundingStart),
                };
                this.updatePosition(position);
              }
            });
          }
        });
      } catch (e) {
        console.log("Error fetching account chunk (RPC?)");
      }
    }
    console.log(`${new Date(Date.now()).toISOString()}: Watching ${this.openPositions.get(symbol)!.size} positions:`);
  }

  /**
   * Checks if any accounts can be liquidated and publishes them via redis.
   * No RPC calls are made here, only price service
   * @param symbol Perpetual symbol
   * @returns number of accounts that can be liquidated
   */
  private async checkPositions(symbol: string) {
    // 1) fetch new px submission
    let newPxSubmission: {
      submission: PriceFeedSubmission;
      pxS2S3: [number, number];
    };
    try {
      // await this._updateAccounts();
      // we update our current submission data if not synced (it can't be used to submit liquidations anyways)
      newPxSubmission = await this.mktData!.fetchPriceSubmissionInfoForPerpetual(symbol);
      if (
        !this.pxSubmission.has(symbol) ||
        this.pxSubmission.get(symbol)!.submission.isMarketClosed.some((x) => x) ||
        !this.checkSubmissionsInSync(this.pxSubmission.get(symbol)!.submission.timestamps)
      ) {
        this.pxSubmission.set(symbol, newPxSubmission);
      }
      // the new submission data may be out of sync or the market may be closed, in which case we stop here
      if (
        newPxSubmission.submission.isMarketClosed.some((x) => x) ||
        !this.checkSubmissionsInSync(newPxSubmission.submission.timestamps)
      ) {
        return false;
      }
    } catch (e) {
      console.log("error fetching from price service:");
      console.log(e);
      return false;
    }
    const positions = this.openPositions.get(symbol)!;
    const curPx = this.pxSubmission.get(symbol)!;
    const accountsSent: Set<string> = new Set();
    // 2) check accounts using current prices
    for (const [trader, position] of positions) {
      if (!this.isMarginSafe(position, curPx.pxS2S3)) {
        await this.redisPubClient.publish(
          "LiquidateTrader",
          JSON.stringify({
            perpetualId: position.perpetualId,
            traderAddr: trader,
            px: curPx.submission,
          })
        );
        accountsSent.add(`${trader}:${symbol}`);
      }
    }
    // 3) check accounts using new prices
    for (const [trader, position] of positions) {
      if (!this.isMarginSafe(position, newPxSubmission.pxS2S3) && !accountsSent.has(`${trader}:${symbol}`)) {
        await this.redisPubClient.publish(
          "LiquidateTrader",
          JSON.stringify({
            perpetualId: position.perpetualId,
            traderAddr: trader,
            px: newPxSubmission.submission,
          })
        );
        accountsSent.add(`${trader}:${symbol}`);
      }
    }
    return accountsSent.size > 0;
  }

  private isMarginSafe(position: Position, pxS2S3: [number, number | undefined]) {
    if (position.positionBC === 0) {
      return true;
    }
    const symbol = this.mktData!.getSymbolFromPerpId(position.perpetualId)!;
    let S2 = pxS2S3[0];
    let Sm = S2 * (1 + this.markPremium.get(symbol)!);
    // undefined -> either S3 = 1 (quote coll) or S3 = S2 (base coll)
    let S3 = pxS2S3[1] ?? (this.isQuote! ? 1 : S2);
    let pos = position.positionBC;
    let lockedIn = position.lockedInQC;
    let cash = position.cashCC + position.unpaidFundingCC;
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
    let min = Math.min(...timestamps);
    let gap = Math.max(...timestamps) - min;
    if (gap > 2 * this.MIN_BLOCKTIME_SECONDS || min < Date.now() / 1_000 - 10) {
      // console.log("feed submissions not synced:", timestamps, " gap =", gap);
      return false;
    }
    return true;
  }
}
