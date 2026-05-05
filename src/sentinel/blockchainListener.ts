import { ABK64x64ToFloat, IPerpetualManager__factory, MarketData, PerpetualDataHandler } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";
import SturdyWebSocket from "sturdy-websocket";
import Websocket from "ws";
import {
  LiquidateMsg,
  LiquidatorConfig,
  PerpEmergencyMsg,
  UpdateMarginAccountMsg,
  UpdateMarkPriceMsg,
} from "../types.js";
import { constructRedis, executeWithTimeout, sleep } from "../utils.js";

import { JsonRpcProvider, Network, SocketProvider, WebSocketProvider } from "ethers";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider.js";
import { MultiUrlWebSocketProvider } from "../multiUrlWebsocketProvider.js";
import { initMarketDataWithCache } from "../sdkInit.js";
import { EmergencyPublishedStore } from "./emergencyPublishedStore.js";
import { createLogger } from "../logger.js";

const log = createLogger("sentinel.listener");

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
  private emergency!: EmergencyPublishedStore;
  private refreshSymbolsInFlight: Promise<void> | null = null;

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
    log.info("unsubscribing");
    if (this.listeningProvider) {
      this.listeningProvider.removeAllListeners();
    }
  }

  public checkHeartbeat() {
    const blockTime = Math.floor((Date.now() - this.lastBlockReceivedAt) / 1_000);
    if (blockTime > this.config.waitForBlockSeconds) {
      log.warn({ receivedSecondsAgo: blockTime }, "Last block received too long ago - heartbeat check failed");
      return false;
    }
    log.info({ receivedSecondsAgo: blockTime }, "Last block received within expected time");
    return true;
  }

  private async switchListeningMode() {
    if (this.switchingRPC) {
      log.warn("already switching RPC");
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
      log.warn("Switching from Websocket to HTTP provider");
      this.mode = ListeningMode.Polling;
      this.listeningProvider = this.httpProvider;
    } else if (this.config.rpcListenWs.length > 0) {
      log.warn(
        { nexRpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() },
        "Switching from HTTP to WS"
      );
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
        log.warn("websocket connection could not be established");
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
        log.info(
          { rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() },
          "attempting to switch to WS"
        );
        const blockReceivedCb = () => {
          log.debug({ rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() }, "block received");
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
            log.warn("attempting to switch to WS failed - block not received");
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
      "could not establish http connection",
    );

    const result = await initMarketDataWithCache(this.md, [this.httpProvider], this.redisPubClient);
    log.info(
      { cache: result.usedCache, cacheAgeMs: result.cacheAgeMs },
      "sentinel MarketData initialized"
    );

    if (this.config.rpcListenWs.length > 0) {
      this.listeningProvider = this.multiUrlWsProvider;
    } else if (this.config.rpcListenHttp.length > 0) {
      this.listeningProvider = this.httpProvider;
    } else {
      throw new Error("Please specify RPC URLs for listening to blockchain events");
    }
    log.info(
      {
        network: {
          name: this.network.name,
          chainId: this.network.chainId,
        },
        listenerType: this.listeningProvider instanceof MultiUrlWebSocketProvider ? "Websocket" : "Http",
      },
      "started"
    );

    this.emergency = new EmergencyPublishedStore();

    this.connectWsOrSwitchToHttp();
    this.addListeners();
    this.resetHealthChecks();
  }

  private refreshSymbolsCoalesced(): Promise<void> {
    if (!this.refreshSymbolsInFlight) {
      this.refreshSymbolsInFlight = this.md.refreshSymbols(true).finally(() => {
        this.refreshSymbolsInFlight = null;
      });
    }
    return this.refreshSymbolsInFlight;
  }

  private async resolveSymbol(perpId: number): Promise<string | undefined> {
    const cached = this.md.getSymbolFromPerpId(perpId);
    if (cached !== undefined) return cached;
    try {
      await this.refreshSymbolsCoalesced();
    } catch (e) {
      console.log({
        event: "refreshSymbolsFailed",
        level: "warn",
        time: new Date().toISOString(),
        perpetualId: perpId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    return this.md.getSymbolFromPerpId(perpId);
  }

  private async addListeners() {
    if (this.listeningProvider === undefined) {
      throw new Error("No provider ready to listen.");
    }

    // on error terminate
    this.listeningProvider.on("error", (e) => {
      log.error({ err: e, mode: this.mode }, "received error msg");
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
        _liquidationPrice: bigint,
        newPositionSizeBC: bigint,
        fFeeCC: bigint,
        fPnlCC: bigint,
        event: any,
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
          block: event.log.blockNumber,
          hash: event.log.transactionHash,
          id: `${event.log.transactionHash}:${event.log.index}`,
        };
        this.redisPubClient.publish("LiquidateEvent", JSON.stringify(msg));
        log.info({ event: "Liquidate", mode: this.mode, ...msg });
      },
    );

    proxy.on(
      proxy.filters.UpdateMarginAccount,
      (
        perpetualId: bigint,
        trader: string,
        _fLockedInValueQC: bigint,
        _fCashCC: bigint,
        _fPositionBC: bigint,
        fFundingPaymentCC: bigint,
        event: any,
      ) => {
        const perpId = Number(perpetualId);
        const symbol = this.md.getSymbolFromPerpId(perpId)!;
        const msg: UpdateMarginAccountMsg = {
          perpetualId: perpId,
          symbol: symbol,
          traderAddr: trader,
          fundingPaymentCC: ABK64x64ToFloat(fFundingPaymentCC),
          block: event.log.blockNumber,
          hash: event.log.transactionHash,
          id: `${event.log.transactionHash}:${event.log.index}`,
        };
        this.redisPubClient.publish("UpdateMarginAccountEvent", JSON.stringify(msg));

        log.debug({
          event: "UpdateMarginAccount",
          mode: this.mode,
          ...msg,
        });
      },
    );

    proxy.on(
      proxy.filters.UpdateMarkPrice,
      (
        perpetualId: bigint,
        fMidPricePremium: bigint,
        fMarkPricePremium: bigint,
        fSpotIndexPrice: bigint,
        event: any,
      ) => {
        const perpId = Number(perpetualId);
        const symbol = this.md.getSymbolFromPerpId(perpId)!;
        const msg: UpdateMarkPriceMsg = {
          perpetualId: perpId,
          symbol: symbol,
          midPremium: ABK64x64ToFloat(fMidPricePremium),
          markPremium: ABK64x64ToFloat(fMarkPricePremium),
          spotIndexPrice: ABK64x64ToFloat(fSpotIndexPrice),
          block: event.log.blockNumber,
          hash: event.log.transactionHash,
          id: `${event.log.transactionHash}:${event.log.index}`,
        };
        this.redisPubClient.publish("UpdateMarkPriceEvent", JSON.stringify(msg));

        log.debug({
          event: "UpdateMarkPrice",
          mode: this.mode,
          ...msg,
        });
      },
    );

    proxy.on(
      proxy.filters.SetEmergencyState,
      async (perpetualId: bigint, _r: bigint, _s2: bigint, _s3: bigint, event: any) => {
        const perpId = Number(perpetualId);
        // SetEmergency is emitted for a given perp twice. 
        // SetEmergency recieved for that perp within the last 10min are ignored.
        if (this.emergency.shouldIgnore(perpId)) return; 
        this.emergency.markPublished(perpId);
        const symbol = await this.resolveSymbol(perpId);
        if (symbol === undefined) return;
        const msg: PerpEmergencyMsg = {
          perpetualId: perpId,
          symbol,
          block: event.log.blockNumber,
          hash: event.log.transactionHash,
          id: `${event.log.transactionHash}:${event.log.index}`,
        };
        this.redisPubClient.publish("PerpEmergency", JSON.stringify(msg));
        log.info({ event: "SetEmergencyState", ...msg });
      },
    );

    proxy.on(proxy.filters.SetNormalState, (perpetualId: bigint, event: any) => {
      const perpId = Number(perpetualId);
      this.emergency.clear(perpId);
      this.redisPubClient.publish(
        "PerpNormal",
        JSON.stringify({
          perpetualId: perpId,
          block: event.log.blockNumber,
          hash: event.log.transactionHash,
          id: `${event.log.transactionHash}:${event.log.index}`,
        }),
      );
      log.info({ event: "SetNormalState", perpetualId: perpId });
    });
  }
}
