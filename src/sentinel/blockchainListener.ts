import { ABK64x64ToFloat, IPerpetualManager__factory, MarketData, PerpetualDataHandler } from "@d8x/perpetuals-sdk";
import { Redis } from "ioredis";
import SturdyWebSocket from "sturdy-websocket";
import Websocket from "ws";
import { LiquidateMsg, LiquidatorConfig, UpdateMarginAccountMsg, UpdateMarkPriceMsg } from "../types";
import { constructRedis, executeWithTimeout, sleep } from "../utils";

import { JsonRpcProvider, Network, WebSocketProvider } from "ethers";

enum ListeningMode {
  Polling = "Polling",
  Events = "Events",
}

export default class BlockhainListener {
  private config: LiquidatorConfig;
  // Network is initialized in start() method
  private network!: Network;

  // objects
  private httpProvider: JsonRpcProvider;
  private listeningProvider: JsonRpcProvider | WebSocketProvider | undefined;
  private redisPubClient: Redis;
  private md: MarketData;

  // state
  private blockNumber: number | undefined;
  private mode: ListeningMode = ListeningMode.Events;
  private lastBlockReceivedAt: number;
  private lastRpcIndex = { http: -1, ws: -1 };

  constructor(config: LiquidatorConfig) {
    this.config = config;
    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(this.config.sdkConfig));
    this.redisPubClient = constructRedis("sentinelPubClient");
    this.httpProvider = new JsonRpcProvider(this.chooseHttpRpc());
    this.lastBlockReceivedAt = Date.now();
  }

  private chooseHttpRpc() {
    const idx = (this.lastRpcIndex.http + 1) % this.config.rpcListenHttp.length;
    this.lastRpcIndex.http = idx;
    console.log(idx, this.config.rpcListenHttp[idx]);
    return this.config.rpcListenHttp[idx];
  }

  private chooseWsRpc() {
    const idx = (this.lastRpcIndex.ws + 1) % this.config.rpcListenWs.length;
    this.lastRpcIndex.ws = idx;
    return this.config.rpcListenWs[idx];
  }

  public unsubscribe() {
    console.log(`${new Date(Date.now()).toISOString()} BlockchainListener: unsubscribing`);
    if (this.listeningProvider) {
      this.listeningProvider.removeAllListeners();
    }
  }

  public checkHeartbeat() {
    const blockTime = Math.floor((Date.now() - this.lastBlockReceivedAt) / 1_000);
    if (blockTime > this.config.waitForBlockSeconds) {
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
    this.blockNumber = undefined;

    // Destroy websockets provider and close underlying connection. Do not call
    // unsubscribe for websocket provider as it will cause async eth_unsubscribe
    // calls while underlying connection is being closed.
    //
    // Change this once ether.js is upgraded to v6
    if (this.listeningProvider instanceof WebSocketProvider) {
      this.listeningProvider.destroy();
    } else {
      this.listeningProvider?.removeAllListeners();
    }

    if (this.mode == ListeningMode.Events || this.config.rpcListenWs.length < 1) {
      console.log(`${new Date(Date.now()).toISOString()}: switching from WS to HTTP`);
      this.mode = ListeningMode.Polling;
      this.listeningProvider = new JsonRpcProvider(this.chooseHttpRpc(), this.network);
    } else if (this.config.rpcListenWs.length > 0) {
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
    }, this.config.waitForBlockSeconds * 1_000);
    await sleep(this.config.waitForBlockSeconds * 1_000);
  }

  private resetHealthChecks() {
    // periodic health checks
    setInterval(async () => {
      if (this.mode == ListeningMode.Events) {
        // currently on WS - check that block time is still reasonable or if we need to switch
        if (!this.checkHeartbeat()) {
          this.switchListeningMode();
        }
      } else if (this.config.rpcListenWs.length > 0) {
        // currently on HTTP - check if we can switch to WS by seeing if we get blocks
        let success = false;
        let wsProvider = new WebSocketProvider(
          new SturdyWebSocket(this.chooseWsRpc(), {
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

          // Destroy the one-off websocket provider and close underlying ws
          // connection.
          wsProvider.destroy();
        }, this.config.waitForBlockSeconds * 1_000);
      }
    }, this.config.healthCheckSeconds * 1_000);
  }

  public async start() {
    // http rpc
    this.network = await executeWithTimeout(
      this.httpProvider.getNetwork(),
      10_000,
      "could not establish http connection"
    );
    await this.md.createProxyInstance(this.httpProvider);
    console.log(
      `${new Date(Date.now()).toISOString()}: connected to ${this.network.name}, chain id ${
        this.network.chainId
      }, using HTTP provider`
    );
    // ws rpc
    if (this.config.rpcListenWs.length > 0) {
      this.listeningProvider = new WebSocketProvider(
        new SturdyWebSocket(this.chooseWsRpc(), {
          wsConstructor: Websocket,
        }),
        this.network
      );
    } else if (this.config.rpcListenHttp.length > 0) {
      this.listeningProvider = new JsonRpcProvider(this.chooseHttpRpc());
    } else {
      throw new Error("Please specify RPC URLs for listening to blockchain events");
    }

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
      // Submit last block received ts to executor/distributor to take action if
      // needed.
      this.redisPubClient.publish("listener-error", this.lastBlockReceivedAt.toString());

      this.unsubscribe();
      this.switchListeningMode();
    });

    this.listeningProvider.on("block", (blockNumber) => {
      this.lastBlockReceivedAt = Date.now();
      this.redisPubClient.publish("block", blockNumber.toString());
      this.blockNumber = blockNumber;
    });

    const proxy = IPerpetualManager__factory.connect(this.md.getProxyAddress(), this.listeningProvider);

    proxy.on(
      proxy.filters.Liquidate,
      (
        perpetualId: bigint,
        liquidator: string,
        trader: string,
        amountLiquidatedBC: bigint,
        liquidationPrice: bigint,
        newPositionSizeBC: bigint,
        fFeeCC: bigint,
        fPnlCC: bigint,
        event
      ) => {
        const perpId = Number(perpetualId);
        const symbol = this.md.getSymbolFromPerpId(perpId)!;
        const msg: LiquidateMsg = {
          perpetualId: perpId,
          symbol: symbol,
          traderAddr: trader,
          tradeAmount: ABK64x64ToFloat(amountLiquidatedBC),
          liquidator: liquidator,
          pnl: ABK64x64ToFloat(fPnlCC),
          fee: ABK64x64ToFloat(fFeeCC),
          newPositionSizeBC: ABK64x64ToFloat(newPositionSizeBC),
          block: event.blockNumber,
          hash: event.transactionHash,
          id: `${event.transactionHash}:${event.index}`,
        };
        this.redisPubClient.publish("LiquidateEvent", JSON.stringify(msg));
        console.log({ event: "Liquidate", time: new Date(Date.now()).toISOString(), mode: ListeningMode, ...msg });
      }
    );

    proxy.on(
      proxy.filters.UpdateMarginAccount,
      (perpetualId: bigint, trader: string, fFundingPaymentCC: bigint, event) => {
        const perpId = Number(perpetualId);
        const symbol = this.md.getSymbolFromPerpId(perpId)!;
        const msg: UpdateMarginAccountMsg = {
          perpetualId: perpId,
          symbol: symbol,
          traderAddr: trader,
          fundingPaymentCC: ABK64x64ToFloat(fFundingPaymentCC),
          block: event.blockNumber,
          hash: event.transactionHash,
          id: `${event.transactionHash}:${event.index}`,
        };
        this.redisPubClient.publish("UpdateMarginAccountEvent", JSON.stringify(msg));

        console.log({
          event: "UpdateMarginAccount",
          time: new Date(Date.now()).toISOString(),
          mode: ListeningMode,
          ...msg,
        });
      }
    );

    proxy.on(
      proxy.filters.UpdateMarkPrice,
      (perpetualId: bigint, fMidPricePremium: bigint, fMarkPricePremium: bigint, fSpotIndexPrice: bigint, event) => {
        const perpId = Number(perpetualId);
        const symbol = this.md.getSymbolFromPerpId(perpId)!;
        const msg: UpdateMarkPriceMsg = {
          perpetualId: perpId,
          symbol: symbol,
          midPremium: ABK64x64ToFloat(fMidPricePremium),
          markPremium: ABK64x64ToFloat(fMarkPricePremium),
          spotIndexPrice: ABK64x64ToFloat(fSpotIndexPrice),
          block: event.blockNumber,
          hash: event.transactionHash,
          id: `${event.transactionHash}:${event.index}`,
        };
        this.redisPubClient.publish("UpdateMarkPriceEvent", JSON.stringify(msg));

        console.log({
          event: "UpdateMarkPrice",
          time: new Date(Date.now()).toISOString(),
          mode: ListeningMode,
          ...msg,
        });
      }
    );

    // proxy.on(
    //   "UpdateUnitAccumulatedFunding",
    //   (perpetualId: number, fUnitAccumulativeFundingCC: BigNumber, event: UpdateUnitAccumulatedFundingEvent) => {
    //     const symbol = this.md.getSymbolFromPerpId(perpetualId)!;
    //     const msg: UpdateUnitAccumulatedFundingMsg = {
    //       perpetualId: perpetualId,
    //       symbol: symbol,
    //       unitAccumulatedFundingCC: ABK64x64ToFloat(fUnitAccumulativeFundingCC),
    //       block: event.blockNumber,
    //       hash: event.transactionHash,
    //       id: `${event.transactionHash}:${event.logIndex}`,
    //     };
    //     this.redisPubClient.publish("UpdateUnitAccumulatedFundingEvent", JSON.stringify(msg));
    //   }
    // );
  }
}
