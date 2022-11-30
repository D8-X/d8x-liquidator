import { MarketData, PerpetualDataHandler, LiquidatorTool, Order, MarginAccount } from "@d8x/perpetuals-sdk";
import {  ethers } from "ethers";
import { PositionBundle, ZERO_POSITION } from "./types";

export default class Liquidator {
  private mktData: MarketData | undefined;
  private liqTool: LiquidatorTool | undefined;
  private proxyContract: ethers.Contract | undefined;
  private perpetualId: number;
  private perpSymbol: string;
  private liquidatorAddr: string | undefined;
  private openPositions: PositionBundle[] = new Array<PositionBundle>();
  private removePositions: PositionBundle[] = new Array<PositionBundle>();
  // private newPositions: PositionBundle[] = new Array<PositionBundle>();
  private isLiquidating: boolean = false;
  private privateKey: string;

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
          console.log(
            `${blockNumber}: Tried: ${res.numSubmitted}, Liquidated: ${res.numLiquidated}`
          );
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
        async (
          perpetualId,
          traderAddr,
          positionId,
          order,
          orderDigest,
          fNewPositionBC,
          price
        ) => {
          if(perpetualId != this.perpetualId) {
            // not our perp
            return;
          }
          if (fNewPositionBC == ZERO_POSITION) {
            console.log(`new trade from address ${traderAddr}`);
            this.removeAccount(traderAddr);
          }
        }
      );
      
      this.proxyContract!.on(
        "Liquidate",
        async (
          perpetualId,
          liquidatorAddr,
          traderAddr,
          positionId,
          fLiquidatedAmount,
          fPrice,
          fNewPositionBC
        ) => {
          if(perpetualId != this.perpetualId) {
            // not our perp
            return;
          }
          if (fNewPositionBC == ZERO_POSITION && liquidatorAddr != this.liquidatorAddr) {
            // someone else liquidated this trader
            console.log(`trader ${traderAddr} was liquidated by ${liquidatorAddr}`);
            this.removeAccount(traderAddr);
          }
        }
      );
    });
  }


  public async removeAccount(traderAddr: string) {
    let account = await this.mktData!.positionRisk(traderAddr, this.perpSymbol);
    this.removePositions.push({address: traderAddr, account: account});
  }

  /**
   * Reset active accounts array
   */
  public async refreshActiveAccounts() {
    if (this.mktData == undefined || this.liqTool == undefined) {
      throw Error("liqTool not defined");
    }
    // get active accounts
    let accountAddresses = await this.liqTool.getAllActiveAccounts(this.perpSymbol);
    let accountPromises: Array<Promise<MarginAccount>> = new Array<Promise<MarginAccount>>();
    for (var k = 0; k < accountAddresses.length; k++) {
      accountPromises.push(this.mktData!.positionRisk(accountAddresses[k], this.perpSymbol));
    }
    let accounts = await Promise.all(accountPromises);
    for (var k = 0; k < accounts.length; k++) {
      this.openPositions.push({address: accountAddresses[k], account: accounts[k]});
    }
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
      let res = await this._liquidate();
      numSubmitted = res[0];
      numLiquidated = res[1];
    } catch (e) {
      console.log(`Error in liquidateTraders: ${e}`);
    }
    return { numSubmitted: numSubmitted, numLiquidated: numLiquidated };
  }

  private async _liquidate(): Promise<number[]> {
    this.isLiquidating = true;
    
    // TODO: remove closed positions from openPositions

    // narrow down potentially liquidatable
    let liquidatable: Array<Promise<boolean>> = new Array<Promise<boolean>>();
    for (let k = 0; k < this.openPositions.length; k++) {
      // query whether the position can be liquidated
        liquidatable.push(this.liqTool!.isMaintenanceMarginSafe(this.perpSymbol, this.openPositions[k].address));
    }
    // wait for all promises
    let isLiquidatable = await Promise.all(liquidatable);
    // try to execute all executable ones
    let executeRequests: Array<Promise<number>> = [];
    let executeIdxInOpenPositions: Array<number> = [];
    for (let k = 0; k < this.openPositions.length; k++) {
      // TODO: should be careful with indexing
      if (isLiquidatable[k]) {
        // execute
        executeRequests.push(this.liqTool!.liquidateTrader(this.perpSymbol, this.openPositions[k].address, this.liquidatorAddr));
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
        this.openPositions.pop()
        numLiquidated += 1;
      }
    }
    this.isLiquidating = false;

    return [numSubmitted, numLiquidated];
  }
}
