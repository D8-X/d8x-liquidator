import {
  ABK64x64ToFloat,
  ERC20__factory,
  IPerpetualManager__factory,
  LimitOrderBook__factory,
  MarketData,
  PerpetualDataHandler,
  dec18ToFloat,
  decNToFloat,
} from "@d8x/perpetuals-sdk";
import { BigNumber } from "@ethersproject/bignumber";
import { Log, Network, StaticJsonRpcProvider, WebSocketProvider } from "@ethersproject/providers";
import { Redis } from "ioredis";
import SturdyWebSocket from "sturdy-websocket";
import Websocket from "ws";
import { LiquidateMsg, ListenerConfig, TradeMsg, UpdateMarginAccountMsg, UpdateMarkPriceMsg } from "../types";
import { chooseRPC, constructRedis, executeWithTimeout, sleep } from "../utils";
import {
  IPerpetualOrder,
  LiquidateEvent,
  TradeEvent,
  UpdateMarginAccountEvent,
  UpdateMarkPriceEvent,
} from "@d8x/perpetuals-sdk/dist/esm/contracts/IPerpetualManager";
import { TransferEvent } from "@d8x/perpetuals-sdk/dist/esm/contracts/ERC20";
import { PerpetualLimitOrderCreatedEvent } from "@d8x/perpetuals-sdk/dist/esm/contracts/LimitOrderBook";

enum ListeningMode {
  Polling = "Polling",
  Events = "Events",
}

export default class BlockhainListener {
  private config: ListenerConfig;
  private network: Network;

  // objects
  private httpProvider: StaticJsonRpcProvider;
  private listeningProvider: StaticJsonRpcProvider | WebSocketProvider | undefined;
  private redisPubClient: Redis;
  private md: MarketData;

  // state
  private blockNumber: number | undefined;
  private mode: ListeningMode = ListeningMode.Events;
  private lastBlockReceivedAt: number;
  private lastRpcIndex = { http: -1, ws: -1 };

  constructor(config: ListenerConfig) {
    this.config = config;
    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(this.config.sdkConfig));
    this.redisPubClient = constructRedis("BlockchainListener");
    this.httpProvider = new StaticJsonRpcProvider(this.chooseHttpRpc());
    this.lastBlockReceivedAt = Date.now();
    this.network = { name: "", chainId: 0 };
  }

  private chooseHttpRpc() {
    const idx = (this.lastRpcIndex.http + 1) % this.config.httpRPC.length;
    this.lastRpcIndex.http = idx;
    return this.config.httpRPC[idx];
  }

  private chooseWsRpc() {
    const idx = (this.lastRpcIndex.ws + 1) % this.config.wsRPC.length;
    this.lastRpcIndex.ws = idx;
    return this.config.wsRPC[idx];
  }

  public unsubscribe() {
    console.log(`${new Date(Date.now()).toISOString()} BlockchainListener: unsubscribing`);
    if (this.listeningProvider) {
      this.listeningProvider.removeAllListeners();
    }
  }

  public checkHeartbeat() {
    const blockTime = Math.floor((Date.now() - this.lastBlockReceivedAt) / 1_000);
    if (blockTime > this.config.waitForBlockseconds) {
      console.log(
        `${new Date(Date.now()).toISOString()}: websocket connection block time is ${blockTime} - disconnecting`
      );
      return false;
    }
    console.log(
      `${new Date(Date.now()).toISOString()}: websocket connection block time is ${blockTime} seconds @ block ${
        this.blockNumber
      }`
    );
    return true;
  }

  private async switchListeningMode() {
    this.unsubscribe();
    this.blockNumber = undefined;
    this.listeningProvider?.removeAllListeners();
    if (this.mode == ListeningMode.Events) {
      console.log(`${new Date(Date.now()).toISOString()}: switching from WS to HTTP`);
      this.mode = ListeningMode.Polling;
      this.listeningProvider = new StaticJsonRpcProvider(this.chooseHttpRpc(), this.network);
    } else {
      console.log(`${new Date(Date.now()).toISOString()}: switching from HTTP to WS`);
      this.mode = ListeningMode.Events;
      this.listeningProvider = new WebSocketProvider(this.chooseWsRpc(), this.network);
    }
    await this.addListeners();
    this.redisPubClient.publish("switch-mode", this.mode);
  }

  private async connectOrSwitch() {
    // try to connect via ws, switch to http on failure
    this.blockNumber = undefined;
    setTimeout(async () => {
      if (!this.blockNumber) {
        console.log(`${new Date(Date.now()).toISOString()}: websocket connection could not be established`);
        await this.switchListeningMode();
      }
    }, this.config.waitForBlockseconds * 1_000);
    await sleep(this.config.waitForBlockseconds * 1_000);
  }

  private resetHealthChecks() {
    // periodic health checks
    setInterval(async () => {
      if (this.mode == ListeningMode.Events) {
        // currently on WS - check that block time is still reasonable or if we need to switch
        if (!this.checkHeartbeat()) {
          this.switchListeningMode();
        }
      } else {
        // currently on HTTP - check if we can switch to WS by seeing if we get blocks
        let success = false;
        let wsProvider = new WebSocketProvider(
          new SturdyWebSocket(chooseRPC(this.config.wsRPC), {
            wsConstructor: Websocket,
          }),
          this.network
        );
        wsProvider.once("block", () => {
          success = true;
        });
        // after N seconds, check if we received a block - if yes, switch
        setTimeout(async () => {
          if (success) {
            await this.switchListeningMode();
          }
        }, this.config.waitForBlockseconds * 1_000);
      }
    }, this.config.healthCheckSeconds * 1_000);
  }

  public async start() {
    // http rpc
    this.network = await executeWithTimeout(this.httpProvider.ready, 10_000, "could not establish http connection");
    await this.md.createProxyInstance(this.httpProvider);
    console.log(
      `${new Date(Date.now()).toISOString()}: connected to ${this.network.name}, chain id ${
        this.network.chainId
      }, using HTTP provider`
    );
    // ws rpc
    if (this.config.wsRPC.length > 0) {
      this.listeningProvider = new WebSocketProvider(
        new SturdyWebSocket(chooseRPC(this.config.wsRPC), {
          wsConstructor: Websocket,
        }),
        this.network
      );
    } else if (this.config.httpRPC.length > 0) {
      this.listeningProvider = new StaticJsonRpcProvider(chooseRPC(this.config.httpRPC));
    } else {
      throw new Error("Please specify your RPC URLs");
    }

    // // get perpetuals and order books
    // this.perpIds = (
    //   await this.md.getReadOnlyProxyInstance().getPoolStaticInfo(1, 255)
    // )[0].flat();

    this.connectOrSwitch();
    this.addListeners();
    this.resetHealthChecks();
  }

  private async addListeners() {
    if (this.listeningProvider === undefined) {
      throw new Error("No provider ready to listen.");
    }
    // on error terminate
    this.listeningProvider.on("error", (e) => {
      console.log(
        `${new Date(Date.now()).toISOString()} BlockchainListener received error msg in ${this.mode} mode:`,
        e
      );
      this.unsubscribe();
      this.switchListeningMode();
    });

    this.listeningProvider.on("block", (blockNumber) => {
      this.lastBlockReceivedAt = Date.now();
      this.redisPubClient.publish("block", blockNumber.toString());
      this.blockNumber = blockNumber;
    });

    const proxy = IPerpetualManager__factory.connect(this.md.getProxyAddress(), this.listeningProvider);

    // proxy.on(
    //   "Trade",
    //   (
    //     perpetualId: number,
    //     trader: string,
    //     positionId: string,
    //     order: IPerpetualOrder.OrderStructOutput,
    //     orderDigest: string,
    //     newPositionSizeBC: BigNumber,
    //     price: BigNumber,
    //     fFeeCC: BigNumber,
    //     fPnlCC: BigNumber,
    //     fB2C: BigNumber,
    //     event: TradeEvent
    //   ) => {
    //     const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
    //     const msg: TradeMsg = {
    //       perpetualId: perpetualId,
    //       symbol: symbol,
    //       orderId: orderDigest,
    //       traderAddr: trader,
    //       tradeAmount: ABK64x64ToFloat(order.fAmount),
    //       broker: order.brokerAddr,
    //       pnl: ABK64x64ToFloat(fPnlCC),
    //       fee: ABK64x64ToFloat(fFeeCC),
    //       newPositionSizeBC: ABK64x64ToFloat(newPositionSizeBC),
    //       block: event.blockNumber,
    //       hash: event.transactionHash,
    //       id: `${event.transactionHash}:${event.logIndex}`,
    //     };
    //     this.redisPubClient.publish("Trade", JSON.stringify(msg));
    //     console.log(`${new Date(Date.now()).toISOString()} Block: ${this.blockNumber}, ${this.mode} mode, Trade:`, msg);
    //   }
    // );

    proxy.on(
      "Liquidate",
      (
        perpetualId: number,
        liquidator: string,
        trader: string,
        positionId: string,
        amountLiquidatedBC: BigNumber,
        liquidationPrice: BigNumber,
        newPositionSizeBC: BigNumber,
        fFeeCC: BigNumber,
        fPnlCC: BigNumber,
        event: LiquidateEvent
      ) => {
        const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
        const msg: LiquidateMsg = {
          perpetualId: perpetualId,
          symbol: symbol,
          traderAddr: trader,
          tradeAmount: ABK64x64ToFloat(amountLiquidatedBC),
          liquidator: liquidator,
          pnl: ABK64x64ToFloat(fPnlCC),
          fee: ABK64x64ToFloat(fFeeCC),
          newPositionSizeBC: ABK64x64ToFloat(newPositionSizeBC),
          block: event.blockNumber,
          hash: event.transactionHash,
          id: `${event.transactionHash}:${event.logIndex}`,
        };
        this.redisPubClient.publish("Liquidate", JSON.stringify(msg));
        console.log(
          `${new Date(Date.now()).toISOString()} Block: ${this.blockNumber}, ${this.mode} mode, Liquidate:`,
          msg
        );
      }
    );

    proxy.on(
      "UpdateMarginAccount",
      (
        perpetualId: number,
        trader: string,
        positionId: string,
        fPositionBC: BigNumber,
        fCashCC: BigNumber,
        fLockedInValueQC: BigNumber,
        fFundingPaymentCC: BigNumber,
        fOpenInterestBC: BigNumber,
        event: UpdateMarginAccountEvent
      ) => {
        const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
        const msg: UpdateMarginAccountMsg = {
          perpetualId: perpetualId,
          symbol: symbol,
          traderAddr: trader,
          positionBC: ABK64x64ToFloat(fPositionBC),
          cashCC: ABK64x64ToFloat(fCashCC),
          lockedInQC: ABK64x64ToFloat(fLockedInValueQC),
          fundingPaymentCC: ABK64x64ToFloat(fFundingPaymentCC),
          block: event.blockNumber,
          hash: event.transactionHash,
          id: `${event.transactionHash}:${event.logIndex}`,
        };
        this.redisPubClient.publish("UpdateMarginAccount", JSON.stringify(msg));
        console.log(
          `${new Date(Date.now()).toISOString()} Block: ${this.blockNumber}, ${this.mode} mode, UpdateMarginAccount:`,
          msg
        );
      }
    );

    proxy.on(
      "UpdateMarkPrice",
      (
        perpetualId: number,
        fMidPricePremium: BigNumber,
        fMarkPricePremium: BigNumber,
        fSpotIndexPrice: BigNumber,
        event: UpdateMarkPriceEvent
      ) => {
        const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
        const msg: UpdateMarkPriceMsg = {
          perpetualId: perpetualId,
          symbol: symbol,
          midPremium: ABK64x64ToFloat(fMidPricePremium),
          markPremium: ABK64x64ToFloat(fMarkPricePremium),
          spotIndexPrice: ABK64x64ToFloat(fSpotIndexPrice),
          block: event.blockNumber,
          hash: event.transactionHash,
          id: `${event.transactionHash}:${event.logIndex}`,
        };
        this.redisPubClient.publish("UpdateMarkPrice", JSON.stringify(msg));
        console.log(
          `${new Date(Date.now()).toISOString()} Block: ${this.blockNumber}, ${this.mode} mode, UpdateMarkPrice:`,
          msg
        );
      }
    );
  }
}
