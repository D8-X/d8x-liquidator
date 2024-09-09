import { ABK64x64ToFloat, IPerpetualManager__factory, MarketData, PerpetualDataHandler } from "@d8x/perpetuals-sdk";
import { Redis } from "ioredis";
import SturdyWebSocket from "sturdy-websocket";
import Websocket from "ws";
import { LiquidateMsg, LiquidatorConfig, UpdateMarginAccountMsg, UpdateMarkPriceMsg } from "../types";
import { constructRedis, executeWithTimeout, sleep } from "../utils";

import { JsonRpcProvider, Network, SocketProvider, WebSocketProvider } from "ethers";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider";
import { MultiUrlWebSocketProvider } from "../multiUrlWebsocketProvider";

enum ListeningMode {
  Polling = "Polling",
  Events = "Events",
}

export default class BlockhainListener {
  private config: LiquidatorConfig;
  // Network is initialized in start() method
  private network!: Network;

  // Single instance of multiurl http provider.
  private httpProvider: MultiUrlJsonRpcProvider;
  // Single instance of multiurl ws provider. When switching listener, we will
  // simply switch to next rpc url in the list.
  private multiUrlWsProvider!: MultiUrlWebSocketProvider;
  private listeningProvider: MultiUrlJsonRpcProvider | MultiUrlWebSocketProvider | undefined;
  private redisPubClient: Redis;
  private md: MarketData;

  // state
  private blockNumber: number | undefined;
  private mode: ListeningMode = ListeningMode.Events;
  private lastBlockReceivedAt: number;
  private lastRpcIndex = { http: -1, ws: -1 };
  private switchingRPC = false;

  constructor(config: LiquidatorConfig) {
    if (config.rpcListenHttp.length <= 0) {
      throw new Error("Please specify at least one HTTP RPC URL in rpcListenHttp configuration field");
    }

    this.config = config;
    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(this.config.sdkConfig));
    this.redisPubClient = constructRedis("sentinelPubClient");
    this.httpProvider = new MultiUrlJsonRpcProvider(this.config.rpcListenHttp, this.md.network, {
      logErrors: false,
      logRpcSwitches: false,
      switchRpcOnEachRequest: true,
      timeoutSeconds: 20,
      maxRetries: this.config.rpcListenHttp.length * 5,

      staticNetwork: true,
      polling: true,
    });
    this.multiUrlWsProvider = new MultiUrlWebSocketProvider(this.config.rpcListenWs, this.network, {
      logErrors: true,
      logRpcSwitches: true,
      maxRetries: this.config.rpcListenWs.length * 4,

      staticNetwork: true,
    });
    this.lastBlockReceivedAt = Date.now();
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
      console.log({
        info: "Last block received too long ago - heartbeat check failed",
        receivedSecondsAgo: blockTime,
        time: new Date(Date.now()).toISOString(),
      });
      return false;
    }
    console.log({
      info: "Last block received within expected time",
      receivedSecondsAgo: blockTime,
      time: new Date(Date.now()).toISOString(),
    });
    return true;
  }

  private async switchListeningMode() {
    if (this.switchingRPC) {
      console.log(`${new Date(Date.now()).toISOString()}: already switching RPC`);
      return;
    }

    this.blockNumber = undefined;
    this.switchingRPC = true;

    // Remove existing listeners. MultiUrlWebSocketProvider handles this
    // internally, so this is only for Http providers.
    if (this.listeningProvider) {
      if (this.listeningProvider instanceof MultiUrlWebSocketProvider) {
        await this.listeningProvider.stop();
      }
      await this.listeningProvider.removeAllListeners();
    }

    if (this.mode == ListeningMode.Events || this.config.rpcListenWs.length < 1) {
      console.log({
        info: "Switching from Websocket to HTTP provider",
        time: new Date(Date.now()).toISOString(),
      });
      this.mode = ListeningMode.Polling;
      this.listeningProvider = this.httpProvider;
    } else if (this.config.rpcListenWs.length > 0) {
      console.log({
        info: "Switching from HTTP to WS",
        nexRpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl(),
        time: new Date(Date.now()).toISOString(),
      });
      this.mode = ListeningMode.Events;
      // startNextWebsocket will be called in health checks, therefore we don't
      // need to do that here.
      this.listeningProvider = this.multiUrlWsProvider;
    }
    this.switchingRPC = false;

    this.listeningProvider!.resetErrorNumber();

    await this.addListeners();
    this.redisPubClient.publish("switch-mode", this.mode);
  }

  /**
   * Wait for blockNumber to come from WS connection or switch to http on
   * failure.
   */
  private async connectWsOrSwitchToHttp() {
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
        // currently on WS - check that block time is still reasonable or if we
        // need to switch
        if (!this.checkHeartbeat()) {
          this.switchListeningMode();
        }
      } else if (this.config.rpcListenWs.length > 0) {
        // currently on HTTP - check if we can switch to WS by seeing if we get
        // blocks with next WS connection.
        let success = false;

        // await this.multiUrlWsProvider.startNextWebsocket(); Do not use once
        // with MultiUrlWebsocketProvider. Also, do not call
        // startNextWebsocket(), multi url provider will handle the switching
        // internally
        await this.multiUrlWsProvider.startNextWebsocket();
        console.log(
          `[${new Date(
            Date.now()
          ).toISOString()}] attempting to switch to WS ${this.multiUrlWsProvider.getCurrentRpcUrl()}`
        );
        const blockReceivedCb = () => {
          console.log("block received", this.multiUrlWsProvider.getCurrentRpcUrl());
          success = true;
        };
        this.multiUrlWsProvider.on("block", blockReceivedCb);
        // after N seconds, check if we received a block - if yes, switch
        setTimeout(async () => {
          if (success) {
            this.multiUrlWsProvider.removeListener("block", blockReceivedCb);
            await this.switchListeningMode();
          } else {
            // Otherwise just stop the multi url ws provider and try again later
            await this.multiUrlWsProvider.stop();
            console.log(
              `[${new Date(Date.now()).toISOString()}] attempting to switch to WS failed - block not received`
            );
          }
        }, this.config.waitForBlockSeconds * 1_000);
      }
    }, this.config.healthCheckSeconds * 1_000);
  }

  public containsEthersConnErrors(error: string) {
    const ethersErrors = [
      "Unexpected server response",
      "SERVER_ERROR",
      "WebSocket was closed before the connection was established",
    ];
    for (const err of ethersErrors) {
      if (error.includes(err)) {
        return true;
      }
    }
    return false;
  }

  public async start() {
    this.network = await executeWithTimeout(
      this.httpProvider.getNetwork(),
      // Use at least 2X timeout of HTTP provider in case some of the rpc are
      // slow to respond.
      40_000,
      "could not establish http connection"
    );

    await this.md.createProxyInstance(this.httpProvider);

    if (this.config.rpcListenWs.length > 0) {
      this.listeningProvider = this.multiUrlWsProvider;
    } else if (this.config.rpcListenHttp.length > 0) {
      this.listeningProvider = this.httpProvider;
    } else {
      throw new Error("Please specify RPC URLs for listening to blockchain events");
    }
    console.log({
      info: "BlockchainListener started",
      time: new Date(Date.now()).toISOString(),
      network: {
        name: this.network.name,
        chainId: this.network.chainId,
      },
      listenerType: this.listeningProvider instanceof MultiUrlWebSocketProvider ? "Websocket" : "Http",
    });

    this.connectWsOrSwitchToHttp();
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
