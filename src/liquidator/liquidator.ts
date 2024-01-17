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
} from "@d8x/perpetuals-sdk";
import { BigNumber, ethers } from "ethers";
import { providers } from "ethers";
import { Redis } from "ioredis";
import { constructRedis } from "../utils";
import { LiquidatorConfig, Position, ZERO_POSITION } from "../types";

export default class Liquidator {
  // objects
  private provider: ethers.providers.Provider | undefined;
  private mktData: MarketData | undefined;
  private liqTool: LiquidatorTool[] | undefined;
  private redisSubClient: Redis;

  // parameters
  private symbols: string[] = [];
  private maintenanceRate: Map<string, number> = new Map();
  private privateKey: string[];

  // state
  private openPositions: Map<string, Map<string, Position>> = new Map();
  private addressUpdate: Map<string, Set<string>> = new Map();
  private addressWatch: Map<string, Set<string>> = new Map();
  private addressAdd: Map<string, Set<string>> = new Map();
  private isLiquidating: boolean = false;
  private config: LiquidatorConfig;
  private pxSubmission: Map<string, { submission: PriceFeedSubmission; pxS2S3: [number, number] }> = new Map();
  private markPremium: Map<string, number> = new Map();
  private isQuote: Map<string, boolean> = new Map();
  private lastRefreshTime: number = Infinity;

  // constants
  private MIN_BLOCKTIME_SECONDS: number = 2;
  private REFRESH_INTERVAL_MS: number = 60 * 60 * 1_000;
  private LIQUIDATE_TOPIC = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Liquidate(uint24,address,address,bytes16,int128,int128,int128)")
  );
  private treasuryAddr: string;
  private moduloTS: number;
  private residualTS: number;
  private LIQUIDATE_INTERVAL_MS: number;
  private peerNonExecutionTimestampMS: Map<string, number>;
  private blockNumber: number;
  private lastLiquidateCall: number = 0;
  private hasQueue: boolean = false;

  constructor(
    privateKey: string | string[],
    // symbol: string,
    config: LiquidatorConfig,
    moduloTS: number,
    residualTS: number,
    treasuryAddr: string
  ) {
    this.privateKey = typeof privateKey == "string" ? [privateKey] : privateKey;
    // this.symbol = symbol;
    this.treasuryAddr = treasuryAddr;
    this.moduloTS = moduloTS;
    this.residualTS = residualTS;
    this.config = config;
    this.LIQUIDATE_INTERVAL_MS = this.config.liquidateIntervalSeconds * 1_000;
    this.REFRESH_INTERVAL_MS = this.config.refreshAccountsSeconds * 1_000;
    this.peerNonExecutionTimestampMS = new Map<string, number>();
    this.redisSubClient = constructRedis("LiquidatorListener");
    this.blockNumber = 0;
  }

  /**
   *
   * @param provider Provider - used to query open positions and execute liquidations
   */
  public async initialize(rpcUrl: string) {
    const provider = new providers.StaticJsonRpcProvider(rpcUrl);
    const chainId = (await provider.getNetwork()).chainId;
    const config = PerpetualDataHandler.readSDKConfig(chainId);
    const md = new MarketData(config);

    // MarketData (read only, no authentication needed)
    this.mktData = md;
    this.liqTool = this.privateKey.map((pk) => new LiquidatorTool(config, pk));

    // Create a proxy instance to access the blockchain
    await this.mktData.createProxyInstance(provider);
    await Promise.all(this.liqTool.map((obj) => obj.createProxyInstance(provider)));

    // get perpetual Id
    // // Create contracts
    // try {
    //   this.perpetualId = this.mktData.getPerpIdFromSymbol(this.symbol);
    // } catch (e) {
    //   // no such perpetual - exit gracefully without restart
    //   console.log(`Perpetual ${this.symbol} not found - bot not running`);
    //   process.exit(0);
    // }
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

    // build all orders
    // this.refreshActiveAccounts();
  }

  /**
   * Listen to events for a number of blocks; requires initialize() first
   * @param maxBlocks number of blocks we will listen to event handlers
   * @returns void
   */
  public async run(): Promise<void> {
    if (this.mktData == undefined || this.liqTool == undefined) {
      throw Error("objects not initialized");
    }
    let numBlocks = -1;

    return new Promise<void>((resolve, reject) => {
      // liquidate periodically
      setInterval(async () => {
        // should check if anyone can be liquidated every minute +- 10 sec
        if (Date.now() - this.lastLiquidateCall < this.LIQUIDATE_INTERVAL_MS) {
          return;
        }
        await this.liquidate();
      }, 10_000);

      setInterval(async () => {
        // checks that we refresh all orders every hour +- 10 sec
        if (Date.now() - this.lastRefreshTime < this.REFRESH_INTERVAL_MS) {
          return;
        }
        await this.refreshActiveAccounts();
      }, 10_000);

      this.redisSubClient.on("message", async (channel, msg) => {
        switch (channel) {
          case "block": {
            numBlocks++;
            break;
          }
          case "Trade": {
            const { perpetualId, traderAddr, fNewPositionBC, digest } = JSON.parse(msg);
            console.log(`${new Date(Date.now()).toISOString()}: Trade received: address: ${traderAddr}, id: ${digest}`);
            this.updateOnEvent(perpetualId, traderAddr, fNewPositionBC);
            this.liquidate();
            break;
          }
          case "Liquidate": {
            const { perpetualId, traderAddr, fNewPositionBC } = JSON.parse(msg);
            console.log(`${new Date(Date.now()).toISOString()}: Liquidate caught, address: ${traderAddr}`);
            this.updateOnEvent(perpetualId, traderAddr, fNewPositionBC);
            this.liquidate();
            break;
          }
          case "UpdateMarkPrice": {
            const { perpetualId, fMarkPremium } = JSON.parse(msg);
            this.markPremium.set(this.mktData?.getSymbolFromPerpId(perpetualId)!, ABK64x64ToFloat(fMarkPremium));
            this.liquidate();
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
    this.openPositions.get(symbol)!.set(position.address, position);
  }

  public updateOnEvent(perpetualId: number, traderAddr: string, fPositionBC: BigNumber) {
    const symbol = this.mktData?.getSymbolFromPerpId(perpetualId)!;
    const watch = this.addressWatch.get(symbol);
    if (watch?.has(traderAddr)) {
      // we are monitoring this trader
      if (fPositionBC == ZERO_POSITION) {
        // position is closed, we should not watch it anymore
        console.log(
          `${new Date(Date.now()).toISOString()}: Trader ${traderAddr} is out - will remove from watch list.`
        );
        this.addressWatch.delete(traderAddr);
      } else {
        // this acount is still open but something about it changed, we should update it
        console.log(`${new Date(Date.now()).toISOString()}: Trader ${traderAddr} traded - will update the account.`);
        if (!this.addressUpdate.has(symbol)) {
          this.addressUpdate.set(symbol, new Set(traderAddr));
        } else {
          this.addressUpdate.get(symbol)?.add(traderAddr);
        }
      }
    } else {
      // we have not seen this trader before
      if (fPositionBC != ZERO_POSITION) {
        // the position is active, so we monitor it
        console.log(
          `${new Date(Date.now()).toISOString()}: New trader ${traderAddr} dectected - will add to watch list.`
        );
        if (!this.addressAdd.has(symbol)) {
          this.addressAdd.set(symbol, new Set(traderAddr));
        } else {
          this.addressAdd.get(symbol)?.add(traderAddr);
        }
      }
    }
  }

  private async _updateAccounts() {
    // remove closed positions
    let k = 0;
    while (k < this.openPositions.length) {
      if (!this.addressWatch.has(this.openPositions[k].address)) {
        // position should be dropped
        console.log(
          `${this.symbol} ${new Date(Date.now()).toISOString()}: Removing trader ${this.openPositions[k].address}`
        );
        this.openPositions[k] = this.openPositions[this.openPositions.length - 1];
        this.openPositions.pop();
        // we don't move index k
        continue;
      } else if (this.addressUpdate.has(this.openPositions[k].address)) {
        // position should be updated
        let traderAddr = this.openPositions[k].address;
        console.log(
          `${this.symbol} ${new Date(Date.now()).toISOString()}: Updating position risk of trader ${traderAddr}`
        );
        let account: MarginAccount;
        try {
          account = (await this.mktData!.positionRisk(traderAddr, this.symbol))[0];
        } catch (e) {
          console.log(
            `${this.symbol} ${new Date(Date.now()).toISOString()}: Error in _updateAccounts: update positionRisk`
          );
          throw e;
        }
        this.openPositions[k] = { address: traderAddr, account: account };
      }
      // can move to next position
      k++;
    }
    // done updating
    this.addressUpdate.clear();
    // add new positions
    let newAddresseses = Array.from(this.addressAdd);
    while (newAddresseses.length > 0) {
      let newAddress = newAddresseses.pop();
      if (!!newAddress) {
        console.log(`${this.symbol} ${new Date(Date.now()).toISOString()}: Adding new trader ${newAddress}`);
        let newAccount: MarginAccount;
        try {
          newAccount = (await this.mktData!.positionRisk(newAddress, this.symbol))[0];
        } catch (e) {
          console.log(
            `${this.symbol} ${new Date(Date.now()).toISOString()}: Error in _updateAccounts: add new positionRisk`
          );
          throw e;
        }
        this.openPositions.push({ address: newAddress, account: newAccount });
        this.addressWatch.add(newAddress);
      }
    }
    // done adding
    this.addressAdd.clear();
  }

  /**
   * Reset active accounts array
   */
  public async refreshActiveAccounts() {
    if (this.mktData == undefined || this.liqTool == undefined) {
      throw Error("liqTool not defined");
    }
    // get active accounts
    // console.log("Counting active accounts...");
    this.lastRefreshTime = Date.now();
    let numAccounts = await this.liqTool[0].countActivePerpAccounts(this.symbol);
    console.log(` ${new Date(Date.now()).toISOString()}: There are ${numAccounts} active accounts`);
    try {
      // console.log("Fetching addresses...");
      let accountAddresses = await this.liqTool[0].getAllActiveAccounts(this.symbol);
      // console.log(`${accountAddresses.length} addresses fetched.`);
      this.addressWatch.clear();
      let accounts: MarginAccount[][] = [];
      for (var k = 0; k < accountAddresses.length; k++) {
        // accountPromises.push(this.mktData!.positionRisk(accountAddresses[k], this.symbol));
        accounts.push(await this.mktData!.positionRisk(accountAddresses[k], this.symbol));
      }
      // console.log("Fetching account information...");
      // let accounts = await Promise.all(accountPromises);
      for (var k = 0; k < accounts.length; k++) {
        // check again that this account makes sense
        if (accounts[k][0].positionNotionalBaseCCY == 0) {
          continue;
        }
        this.openPositions.push({ address: accountAddresses[k], account: accounts[k][0] });
        this.addressWatch.add(accountAddresses[k]);
      }
      // console.log("Accounts fetched.");
    } catch (e) {
      console.log(`${this.symbol} ${new Date(Date.now()).toISOString()}: Error in refreshActiveAccounts:`);
      throw e;
    }
    console.log(
      `${this.symbol} ${new Date(Date.now()).toISOString()}: Watching ${this.openPositions.length} positions:`
    );
    // console.log(this.openPositions);
    this.openPositions.map((p) => console.log(`${p.address} (${Math.round(p.account.leverage * 100) / 100}x)`));
  }

  /**
   * Liquidate traders. Removes closed positions from list.
   * @returns statistics for liquidation
   */
  public async liquidate(perpetualId: number) {
    // if (this.mktData == undefined || this.liqTool == undefined) {
    //   throw Error("objects not initialized");
    // }
    // if (this.isLiquidating) {
    //   return { numSubmitted: 0, numLiquidated: 0 };
    // }
    if (this.isLiquidating) {
      return;
    }

    const symbol = this.mktData!.getSymbolFromPerpId(perpetualId)!;

    let numSubmitted = 0;
    let numLiquidated = 0;
    let submission: { submission: PriceFeedSubmission; pxS2S3: [number, number] };
    this.hasQueue = false;
    this.lastLiquidateCall = Date.now();
    try {
      // await this._updateAccounts();
      // we update our current submission data if not synced (it can't be used to submit liquidations anyways)
      submission = await this.mktData!.fetchPriceSubmissionInfoForPerpetual(symbol);
      if (
        !this.pxSubmission.has(symbol) ||
        this.pxSubmission.get(symbol)!.submission.isMarketClosed.some((x) => x) ||
        !this.checkSubmissionsInSync(this.pxSubmission.get(symbol)!.submission.timestamps)
      ) {
        this.pxSubmission.set(symbol, submission);
      }
      // the new submission data may be out of sync or the market may be closed, in which case we stop here
      if (
        submission.submission.isMarketClosed.some((x) => x) ||
        !this.checkSubmissionsInSync(submission.submission.timestamps)
      ) {
        this.isLiquidating = false;
        return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
      }
      // at this point we have two sets of submission data
      // 1) both are in sync (can be used to submit)
      // 2) 'this.submission' could be a bit older than 'submission'
      let res = await this._liquidate(submission);
      numSubmitted = res.numLiquidated;
      numLiquidated = res.numSubmitted;
    } catch (e) {
      console.log("Error in liquidateTraders:");
      console.log(e);
    }
    this.isLiquidating = false;
    return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
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

  private async _liquidate(submission: {
    submission: PriceFeedSubmission;
    pxS2S3: [number, number];
  }): Promise<{ numSubmitted: number; numLiquidated: number }> {
    this.isLiquidating = true;

    // check who can be liquidated using currently ("old") stored prices
    let isLiquidatable = this.openPositions.map(
      (p: PositionBundle) => !this.isMarginSafe(p.account, this.submission!.pxS2S3)
    );
    if (!isLiquidatable.some((x) => x)) {
      // nobody: try new prices then
      isLiquidatable = this.openPositions.map((p: PositionBundle) => !this.isMarginSafe(p.account, submission.pxS2S3));
      this.submission = submission;
      // any liquidations possible with new prices?
      if (!isLiquidatable.some((x) => x)) {
        // no, release lock and continue
        this.isLiquidating = false;
        return { numSubmitted: 0, numLiquidated: 0 };
      }
    }

    if (this.config.gasStation && this.config.gasStation !== "") {
      try {
        // check gas price
        const gasInfo = await fetch(this.config.gasStation)
          .then((res) => res.json())
          .then((info) => info as GasInfo);
        const gasPrice = typeof gasInfo.safeLow == "number" ? gasInfo.safeLow : (gasInfo.safeLow as GasPriceV2).maxfee;
        if (gasPrice > this.config.maxGasPriceGWei) {
          // if the lowest we need to pay is higher than the max allowed, we cannot proceed
          console.log(
            `gas price is too high: ${gasPrice} > ${this.config.maxGasPriceGWei} (low/market/high) = (${gasInfo.safeLow}/${gasInfo.standard}/${gasInfo.fast}) gwei, target max = ${this.config.maxGasPriceGWei} gwei)`
          );
          this.isLiquidating = false;
          return { numSubmitted: 0, numLiquidated: 0 };
        }
      } catch (e) {
        console.log("could not fetch gas price");
      }
    }

    // we're here so we can liquidate with stored prices
    let liquidateRequests: Array<Promise<ethers.ContractTransaction>> = [];
    let liquidateIdxInOpenPositions: Array<number> = [];
    let numToLiquidate = 0;
    for (let k = 0; k < this.openPositions.length && numToLiquidate < this.liqTool!.length; k++) {
      if (isLiquidatable[k]) {
        // will try to liquidate
        console.log(
          `${this.symbol} ${new Date(Date.now()).toISOString()}: adding trader ${
            this.openPositions[k].address
          } to slot ${numToLiquidate} in this batch:`
        );
        // console.log(this.openPositions[k].account);
        // liquidate
        liquidateRequests.push(
          this.liqTool![numToLiquidate].liquidateTrader(
            this.symbol,
            this.openPositions[k].address,
            this.treasuryAddr,
            this.submission!.submission,
            {
              gasLimit: 2_000_000,
              splitTx: false,
            }
          )
        );
        liquidateIdxInOpenPositions.push(k);
        numToLiquidate++;
      }
    }
    // update submission data just in case, this set is 'used'
    this.submission = submission;

    // remove positions we will try to liquidate from the watch list and release the lock
    liquidateIdxInOpenPositions = liquidateIdxInOpenPositions.sort((a, b) => b - a);
    for (let k = 0; k < liquidateIdxInOpenPositions.length; k++) {
      // remove order from list
      let idx = liquidateIdxInOpenPositions[k];
      this.openPositions[idx] = this.openPositions[this.openPositions.length - 1];
      this.openPositions.pop();
    }
    this.isLiquidating = false;

    // send the liquidation requests
    let txArray: Array<ethers.ContractTransaction>;
    try {
      txArray = await Promise.all(liquidateRequests);
      // requests could be sent, so this bot is running
      this.confirmedRunning = true;
    } catch (e) {
      console.log("_liquidate: submit liquidations:");
      // console.log(e);
      this.confirmedRunning = false;
      throw e;
    }
    let numSubmitted = txArray.length;
    let numLiquidated = 0;
    for (let k = 0; k < txArray.length; k++) {
      let receipt: ethers.ContractReceipt;
      try {
        receipt = await txArray[k].wait();
        console.log(`${this.symbol} ${new Date(Date.now()).toISOString()}: Tried tx=${txArray[k].hash}`);
        if (receipt.status == 1) {
          let liqEvent = receipt.events?.filter((event) => event.topics[0] == this.LIQUIDATE_TOPIC);
          if (liqEvent?.length) {
            // transaction went through and we got paid, so order was succesfully executed
            numLiquidated++;
            // totalReward += ABK64x64ToFloat(ethers.BigNumber.from(liqEvent[0].data));
          }
        }
      } catch (e) {
        console.log(`${this.symbol} ${new Date(Date.now()).toISOString()}: Failed tx=${txArray[k].hash}`);
        // don't throw - either it workd and events will update/remove the position, or it didn't and nothing has to change
      }
    }
    this.isLiquidating = false;

    return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
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
