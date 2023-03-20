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
} from "@d8x/perpetuals-sdk";
import { BigNumber, ethers } from "ethers";
import { writeFileSync } from "fs";
import { LiqConfig, PositionBundle, ZERO_POSITION } from "./types";

export default class Liquidator {
  private mktData: MarketData | undefined;
  private liqTool: LiquidatorTool[] | undefined;
  private proxyContract: ethers.Contract | undefined;
  private perpetualId: number | undefined;
  private perpSymbol: string;
  private maintenanceRate: number | undefined;
  private liquidatorAddr: string | undefined;
  private openPositions: PositionBundle[] = new Array<PositionBundle>();
  private addressUpdate: Set<string> = new Set<string>();
  private addressWatch: Set<string> = new Set<string>();
  private addressAdd: Set<string> = new Set<string>();
  private isLiquidating: boolean = false;
  private privateKey: string[];
  private submission: { submission: PriceFeedSubmission; pxS2S3: [number, number] } | undefined;
  private markPremium: number | undefined;
  private isQuote: boolean | undefined;
  // params
  private minPositionSizeToLiquidate: number | undefined = undefined;
  private config: LiqConfig;
  private confirmedRunning: boolean = false;
  private currentBlockNumber: number = 0;
  private MIN_BLOCKTIME_SECONDS: number = 2;
  private LIQUIDATE_TOPIC = ethers.utils.keccak256(
    ethers.utils.toUtf8Bytes("Liquidate(uint24,address,address,bytes16,int128,int128,int128)")
  );

  constructor(privateKey: string, perpSymbol: string, config: LiqConfig, liquidatorAddr?: string) {
    this.privateKey = typeof privateKey == "string" ? [privateKey] : privateKey;
    this.perpSymbol = perpSymbol;
    this.liquidatorAddr = liquidatorAddr;
    this.config = config;
  }

  private initObjects(RPC?: string) {
    // load configuration for testnet
    const config = PerpetualDataHandler.readSDKConfig("central-park");
    if (RPC != undefined) {
      config.nodeURL = RPC;
    }
    // MarketData (read only, no authentication needed)
    this.mktData = new MarketData(config);
    this.liqTool = this.privateKey.map((pk) => new LiquidatorTool(config, pk));
  }

  public async initialize(RPC?: string, provider?: ethers.providers.JsonRpcProvider) {
    this.initObjects(RPC);
    if (this.mktData == undefined || this.liqTool == undefined) {
      throw Error("objects not initialized");
    }
    // Create a proxy instance to access the blockchain
    await this.mktData.createProxyInstance();
    await Promise.all(this.liqTool.map((obj) => obj.createProxyInstance(provider)));
    console.log("Proxy instances created.");
    // get perpetual Id
    this.perpetualId = this.mktData.getPerpIdFromSymbol(this.perpSymbol);
    this.maintenanceRate = this.mktData.getPerpetualStaticInfo(this.perpSymbol).maintenanceMarginRate;
    this.isQuote =
      this.mktData.getPerpetualStaticInfo(this.perpSymbol).collateralCurrencyType == COLLATERAL_CURRENCY_QUOTE;
    this.submission = await this.mktData.fetchPriceSubmissionInfoForPerpetual(this.perpSymbol);
    this.markPremium =
      (await this.mktData.getMarkPrice(this.perpSymbol, this.submission.pxS2S3)) / this.submission.pxS2S3[0] - 1;
    // set minimal position size to liquidate: $1000 at mark price
    this.minPositionSizeToLiquidate = 1_000 / (await this.mktData!.getMarkPrice(this.perpSymbol));
    // build all orders
    await this.refreshActiveAccounts();
  }

  private unsubscribe() {
    console.log("Unsubscribing");
    this.proxyContract!.provider.removeAllListeners();
  }

  /**
   * Listen to events for a number of blocks; requires initialize() first
   * @param maxBlocks number of blocks we will listen to event handlers
   * @returns void
   */
  public async runForNumBlocks(maxBlocks: number): Promise<void> {
    // listen to blocks
    if (this.mktData == undefined || this.liqTool == undefined) {
      throw Error("objects not initialized");
    }
    this.proxyContract = await this.mktData.getReadOnlyProxyInstance();
    let numBlocks = -1;
    return new Promise<void>((resolve, reject) => {
      // on every block:
      this.proxyContract!.provider.on("block", async (blockNumber) => {
        try {
          // count block, maybe stop
          numBlocks++;
          if (numBlocks > maxBlocks) {
            this.unsubscribe();
            this.logPulseToFile();
            return resolve();
          }
          this.currentBlockNumber = blockNumber;
          // maybe liquidate
          let res = await this.liquidateTraders();
          if (numBlocks % 10 == 0 || res.numSubmitted > 0) {
            console.log(
              `${blockNumber} ${new Date(Date.now()).toISOString()}: (${numBlocks}/${maxBlocks}), Tried: ${
                res.numSubmitted
              }, Liquidated: ${res.numLiquidated}, confirmed running: ${this.confirmedRunning}`
            );
          }
        } catch (e) {
          // error will be logged outside, we just send it in reject()
          console.log(`${new Date(Date.now()).toISOString()} Error in block ${blockNumber} processing callback:`);
          this.unsubscribe();
          return reject(e);
        }
      });

      // on Trade event
      this.proxyContract!.on(
        "Trade",
        async (perpetualId, traderAddr, positionId, order, orderDigest, fNewPositionBC, price) => {
          if (perpetualId != this.perpetualId) {
            // not our perp
            return;
          }
          console.log(
            `${this.currentBlockNumber} ${new Date(Date.now()).toISOString()} Trade caught: order id ${orderDigest}`
          );
          this.updateOnEvent(traderAddr, fNewPositionBC);
        }
      );

      // on Liquidate event
      this.proxyContract!.on(
        "Liquidate",
        async (perpetualId, liquidatorAddr, traderAddr, positionId, fLiquidatedAmount, fPrice, fNewPositionBC) => {
          if (perpetualId != this.perpetualId) {
            // not our perp
            return;
          }
          console.log(`${this.currentBlockNumber} ${new Date(Date.now()).toISOString()} Liquidate caught`);
          this.updateOnEvent(traderAddr, fNewPositionBC);
        }
      );

      // on mark price update
      this.proxyContract!.on("UpdateMarkPrice", (perpId, fMidPremium, fMarkPremium, fSpotPriceS2) => {
        if (this.perpetualId == perpId) {
          this.markPremium = ABK64x64ToFloat(fMarkPremium);
        }
      });
    });
  }

  public updateOnEvent(traderAddr: string, fPositionBC: BigNumber) {
    if (this.addressWatch.has(traderAddr)) {
      // we are monitoring this trader
      if (fPositionBC == ZERO_POSITION) {
        // position is closed, we should not watch it anymore
        console.log(`Trader ${traderAddr} is out - will remove from watch list.`);
        this.addressWatch.delete(traderAddr);
      } else {
        // this acount is still open but something about it changed, we should update it
        console.log(`Trader ${traderAddr} did something - will update the account.`);
        this.addressUpdate.add(traderAddr);
      }
    } else {
      // we have not seen this trader before
      if (fPositionBC != ZERO_POSITION) {
        // the position is active, so we monitor it
        console.log(`New trader ${traderAddr} dectected - will add to watch list.`);
        this.addressAdd.add(traderAddr);
      }
    }
  }

  private async _updateAccounts() {
    // remove closed positions
    let k = 0;
    while (k < this.openPositions.length) {
      if (!this.addressWatch.has(this.openPositions[k].address)) {
        // position should be dropped
        console.log(`Removing trader ${this.openPositions[k].address}`);
        this.openPositions[k] = this.openPositions[this.openPositions.length - 1];
        this.openPositions.pop();
        // we don't move index k
        continue;
      } else if (this.addressUpdate.has(this.openPositions[k].address)) {
        // position should be updated
        let traderAddr = this.openPositions[k].address;
        console.log(`Updating position risk of trader ${traderAddr}`);
        let account: MarginAccount;
        try {
          account = await this.mktData!.positionRisk(traderAddr, this.perpSymbol);
        } catch (e) {
          console.log("Error in _updateAccounts: update positionRisk");
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
      console.log(`Adding new trader ${newAddress}`);
      let newAccount: MarginAccount;
      try {
        newAccount = await this.mktData!.positionRisk(newAddress!, this.perpSymbol);
      } catch (e) {
        console.log("Error in _updateAccounts: add new positionRisk");
        throw e;
      }
      this.openPositions.push({ address: newAddress!, account: newAccount });
      this.addressWatch.add(newAddress!);
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
    let numAccounts = await this.liqTool[0].countActivePerpAccounts(this.perpSymbol);
    console.log(`There are ${numAccounts} active accounts`);
    try {
      console.log("Fetching addresses...");
      let accountAddresses = await this.liqTool[0].getAllActiveAccounts(this.perpSymbol);
      console.log(`${accountAddresses.length} addresses fetched.`);
      let accountPromises: Array<Promise<MarginAccount>> = new Array<Promise<MarginAccount>>();
      this.addressWatch.clear();
      for (var k = 0; k < accountAddresses.length; k++) {
        accountPromises.push(this.mktData!.positionRisk(accountAddresses[k], this.perpSymbol));
      }
      console.log("Fetching account information...");
      let accounts = await Promise.all(accountPromises);
      for (var k = 0; k < accounts.length; k++) {
        // check again that this account makes sense
        if (accounts[k].positionNotionalBaseCCY == 0) {
          continue;
        }
        this.openPositions.push({ address: accountAddresses[k], account: accounts[k] });
        this.addressWatch.add(accountAddresses[k]);
      }
      // console.log("Accounts fetched.");
    } catch (e) {
      console.log("Error in refreshActiveAccounts:");
      throw e;
    }
    console.log("Watching positions:");
    // console.log(this.openPositions);
    this.openPositions.map((p) => console.log(p.address));
  }

  /**
   * Liquidate traders. Removes closed positions from list.
   * @returns statistics for liquidation
   */
  public async liquidateTraders(): Promise<{ numSubmitted: number; numLiquidated: number }> {
    if (this.mktData == undefined || this.liqTool == undefined || this.proxyContract == undefined) {
      throw Error("objects not initialized");
    }
    if (this.isLiquidating) {
      return { numSubmitted: 0, numLiquidated: 0 };
    }
    let numSubmitted = 0;
    let numLiquidated = 0;
    let submission: { submission: PriceFeedSubmission; pxS2S3: [number, number] };
    try {
      await this._updateAccounts();
      // we update our current submission data if not synced (it can't be used to submit liquidations anyways)
      submission = await this.mktData.fetchPriceSubmissionInfoForPerpetual(this.perpSymbol);
      if (!this.checkSubmissionsInSync(this.submission!.submission.timestamps)) {
        this.submission = submission;
      }
      // the new submission data may be out of sync, in which case we stop here
      if (!this.checkSubmissionsInSync(submission.submission.timestamps)) {
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
      this.confirmedRunning = false;
    }
    this.isLiquidating = false;
    return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
  }

  private isMarginSafe(account: MarginAccount, pxS2S3: [number, number | undefined]) {
    if (account.side == CLOSED_SIDE) {
      return true;
    }
    let S2 = pxS2S3[0];
    let Sm = S2 * (1 + this.markPremium!);
    // undefined -> either S3 = 1 (quote coll) or S3 = S2 (base coll)
    let S3 = pxS2S3[1] ?? (this.isQuote! ? 1 : S2);
    let pos = account.positionNotionalBaseCCY * (account.side == BUY_SIDE ? 1 : -1);
    let lockedIn = account.entryPrice * pos;
    let cash = account.collateralCC + account.unrealizedFundingCollateralCCY;
    let maintenanceMargin = ((Math.abs(pos) * Sm) / S3) * this.maintenanceRate!;
    let balance = cash + (pos * Sm - lockedIn) / S3;
    return balance >= maintenanceMargin;
  }

  private async _liquidate(submission: {
    submission: PriceFeedSubmission;
    pxS2S3: [number, number];
  }): Promise<{ numSubmitted: number; numLiquidated: number }> {
    this.isLiquidating = true;
    this.confirmedRunning = false;

    // check who can be liquidated using currently ("old") stored prices
    let isLiquidatable = this.openPositions.map(
      (p: PositionBundle) => !this.isMarginSafe(p.account, this.submission!.pxS2S3)
    );
    if (!isLiquidatable.some((x) => x)) {
      // nobody: try new prices then
      isLiquidatable = this.openPositions.map((p: PositionBundle) => !this.isMarginSafe(p.account, submission.pxS2S3));
      this.submission = submission;
      // no liquidations possible even with new prices
      if (!isLiquidatable.some((x) => x)) {
        // release lock and continue
        this.isLiquidating = false;
        return { numSubmitted: 0, numLiquidated: 0 };
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
          `${this.currentBlockNumber} ${new Date(Date.now()).toISOString()}: adding trader ${
            this.openPositions[k].address
          } to slot ${numToLiquidate} in this batch:`
        );
        // console.log(this.openPositions[k].account);
        // liquidate
        liquidateRequests.push(
          this.liqTool![numToLiquidate].liquidateTrader(
            this.perpSymbol,
            this.openPositions[k].address,
            this.liquidatorAddr,
            this.submission!.submission
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
        console.log(`Tried tx=${txArray[k].hash}`);
      } catch (e) {
        console.log(`Failed tx=${txArray[k].hash}`);
        throw e;
      }
      if (receipt.status == 1) {
        let liqEvent = receipt.events?.filter((event) => event.topics[0] == this.LIQUIDATE_TOPIC);
        if (liqEvent?.length) {
          // transaction went through and we got paid, so order was succesfully executed
          numLiquidated++;
          // totalReward += ABK64x64ToFloat(ethers.BigNumber.from(liqEvent[0].data));
        }
      }
    }
    this.isLiquidating = false;

    return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
  }

  /**
   * write current UTC timestamp to file for watcher
   */
  private logPulseToFile() {
    let filename = `${this.config.watchDogPulseLogDir}/pulse${this.perpSymbol}.txt`;
    let timestamp = Date.now().toString();
    writeFileSync(filename, timestamp, { flag: "w" });
  }

  /**
   * Check that max(t) - min (t) <= threshold
   * @param timestamps Array of timestamps
   * @returns True if the timestamps are sufficiently close to each other
   */
  private checkSubmissionsInSync(timestamps: number[]): boolean {
    let gap = Math.max(...timestamps) - Math.min(...timestamps);
    if (gap > 2 * this.MIN_BLOCKTIME_SECONDS) {
      console.log("feed submissions not synced:", timestamps, " gap =", gap);
      return false;
    }
    return true;
  }
}
