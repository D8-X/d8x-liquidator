import { MarketData, PerpetualDataHandler, LiquidatorTool, MarginAccount } from "@d8x/perpetuals-sdk";
import { BigNumber, ethers } from "ethers";
import { PositionBundle, ZERO_POSITION } from "./types";

export default class Liquidator {
  private mktData: MarketData | undefined;
  private liqTool: LiquidatorTool | undefined;
  private proxyContract: ethers.Contract | undefined;
  private perpetualId: number | undefined;
  private perpSymbol: string;
  private liquidatorAddr: string | undefined;
  private openPositions: PositionBundle[] = new Array<PositionBundle>();
  private addressUpdate: Set<string> = new Set<string>();
  private addressWatch: Set<string> = new Set<string>();
  private addressAdd: Set<string> = new Set<string>();
  private isLiquidating: boolean = false;
  private privateKey: string;
  private minPositionSizeToLiquidate: number | undefined = undefined;

  constructor(privateKey: string, perpSymbol: string, liquidatorAddr?: string) {
    this.privateKey = privateKey;
    this.perpSymbol = perpSymbol;
    this.liquidatorAddr = liquidatorAddr;
  }

  private initObjects(RPC?: string) {
    // load configuration for testnet
    const config = PerpetualDataHandler.readSDKConfig("testnet");
    if (RPC != undefined) {
      config.nodeURL = RPC;
    }
    // MarketData (read only, no authentication needed)
    this.mktData = new MarketData(config);
    this.liqTool = new LiquidatorTool(config, this.privateKey);
  }

  public async initialize(RPC?: string) {
    this.initObjects(RPC);
    if (this.mktData == undefined || this.liqTool == undefined) {
      throw Error("objects not initialized");
    }
    // Create a proxy instance to access the blockchain
    await this.mktData.createProxyInstance();
    await this.liqTool.createProxyInstance();
    // get perpetual Id
    this.perpetualId = this.mktData.getPerpIdFromSymbol(this.perpSymbol);
    // set minimal position size to liquidate: $1000 at mark price
    this.minPositionSizeToLiquidate = 1_000 / (await this.mktData!.getMarkPrice(this.perpSymbol));
    // build all orders
    await this.refreshActiveAccounts();
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
    let numBlocks = 0;
    return new Promise<void>((resolve, reject) => {
      this.proxyContract!.provider.on("block", async (blockNumber) => {
        try {
          let res = await this.liquidateTraders();
          numBlocks++;
          console.log(`${blockNumber}: Tried: ${res.numSubmitted}, Liquidated: ${res.numLiquidated}`);
          if (numBlocks >= maxBlocks) {
            resolve();
          }
        } catch (e) {
          console.log(`Error in block processing callback:`, e);
          reject(e);
        }
      });

      this.proxyContract!.on(
        "Trade",
        async (perpetualId, traderAddr, positionId, order, orderDigest, fNewPositionBC, price) => {
          console.log("Trade caught");
          if (perpetualId != this.perpetualId) {
            // not our perp
            return;
          }
          this.updateOnEvent(traderAddr, fNewPositionBC);
        }
      );

      // this.proxyContract!.on(
      //   "UpdateMarginAccount",
      //   async (
      //     perpetualId,
      //     traderAddr,
      //     positionId,
      //     fPositionBC,
      //     fCashCC,
      //     fLockedInValueQC,
      //     fFundingPayment,
      //     fOpenInterest
      //   ) => {
      //     console.log("UpdateMarginAccount caught");
      //     if (perpetualId != this.perpetualId) {
      //       // not our perp
      //       return;
      //     }
      //     this.updateOnEvent(traderAddr, fPositionBC);
      //   }
      // );

      this.proxyContract!.on(
        "Liquidate",
        async (perpetualId, liquidatorAddr, traderAddr, positionId, fLiquidatedAmount, fPrice, fNewPositionBC) => {
          console.log("Liquidate caught");
          if (perpetualId != this.perpetualId) {
            // not our perp
            return;
          }
          this.updateOnEvent(traderAddr, fNewPositionBC);
        }
      );
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
        // something changed in this account, we should update it
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
        let account = await this.mktData!.positionRisk(traderAddr, this.perpSymbol);
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
      let newAccount = await this.mktData!.positionRisk(newAddress!, this.perpSymbol);
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
    let numAccounts = await this.liqTool.countActivePerpAccounts(this.perpSymbol);
    console.log(`There are ${numAccounts} active accounts`);
    let accountAddresses = await this.liqTool.getAllActiveAccounts(this.perpSymbol);
    let accountPromises: Array<Promise<MarginAccount>> = new Array<Promise<MarginAccount>>();
    this.addressWatch.clear();
    for (var k = 0; k < accountAddresses.length; k++) {
      accountPromises.push(this.mktData!.positionRisk(accountAddresses[k], this.perpSymbol));
    }
    let accounts = await Promise.all(accountPromises);
    for (var k = 0; k < accounts.length; k++) {
      this.openPositions.push({ address: accountAddresses[k], account: accounts[k] });
      this.addressWatch.add(accountAddresses[k]);
    }
    console.log("Addresses:");
    console.log(this.addressWatch);
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
    try {
      await this._updateAccounts();
      let res = await this._liquidate();
      numSubmitted = res[0];
      numLiquidated = res[1];
    } catch (e) {
      console.log(`Error in liquidateTraders: ${e}`);
    }
    this.isLiquidating = false;
    return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
  }

  private async _liquidate(): Promise<number[]> {
    this.isLiquidating = true;
    // narrow down potentially liquidatable
    let liquidatable: Array<Promise<boolean>> = new Array<Promise<boolean>>();
    for (let k = 0; k < this.openPositions.length; k++) {
      // query whether the position can be liquidated
      let shouldLiquidate = this.liqTool!.isMaintenanceMarginSafe(this.perpSymbol, this.openPositions[k].address).then(
        (x) => !x && this.openPositions[k].account.positionNotionalBaseCCY > this.minPositionSizeToLiquidate!
      );
      liquidatable.push(shouldLiquidate);
    }
    // wait for all promises
    let isLiquidatable = await Promise.all(liquidatable);
    // try to execute all executable ones
    let executeRequests: Array<Promise<number>> = [];
    let executeIdxInOpenPositions: Array<number> = [];
    for (let k = 0; k < this.openPositions.length; k++) {
      if (isLiquidatable[k]) {
        // execute
        executeRequests.push(
          this.liqTool!.liquidateTrader(this.perpSymbol, this.openPositions[k].address, this.liquidatorAddr)
        );
        executeIdxInOpenPositions.push(k);
      }
    }
    // wait for all requests to go through and determine what was executed
    let amountsArray = await Promise.all(executeRequests);
    let numSubmitted = amountsArray.length;
    let numLiquidated = 0;
    for (let k = 0; k < amountsArray.length; k++) {
      if (amountsArray[k] != 0) {
        let idx = executeIdxInOpenPositions[k];
        this.openPositions[idx] = this.openPositions[this.openPositions.length - 1];
        this.openPositions.pop();
        numLiquidated += 1;
      }
    }
    this.isLiquidating = false;

    return [numSubmitted, numLiquidated];
  }
}
