import { IPerpetualManager__factory, MarketData, PerpetualDataHandler } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";
import { LiquidatorConfig, PerpEmergencyMsg } from "../types.js";
import { constructRedis, errMsg, executeWithTimeout, sleep } from "../utils.js";

import { Network } from "ethers";
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

type ListeningProvider = MultiUrlJsonRpcProvider | MultiUrlWebSocketProvider;

interface EventLogFields {
  blockNumber: number;
  transactionHash: string;
  index: number;
}

function readEventLog(event: unknown): EventLogFields {
  if (event === null || typeof event !== "object") {
    return { blockNumber: 0, transactionHash: "", index: 0 };
  }
  const withLog = event as { log?: Partial<EventLogFields> } & Partial<EventLogFields>;
  const source: Partial<EventLogFields> =
    withLog.log && typeof withLog.log.blockNumber === "number" ? withLog.log : withLog;
  return {
    blockNumber: source.blockNumber ?? 0,
    transactionHash: source.transactionHash ?? "",
    index: source.index ?? 0,
  };
}

export default class BlockhainListener {
  private config: LiquidatorConfig;
  // Network is initialized in start() method
  private network!: Network;

  // Single instance of multiurl http provider.
  private httpProvider: MultiUrlJsonRpcProvider;
  // Single instance of multiurl ws provider. When switching listener, we will
  // simply switch to next rpc url in the list.
  private multiUrlWsProvider: MultiUrlWebSocketProvider;
  private listeningProvider: ListeningProvider | undefined;
  private redisPubClient: Redis;
  private md: MarketData;

  // state
  private blockNumber: number | undefined;
  private mode: ListeningMode = ListeningMode.Events;
  private lastBlockReceivedAt: number;
  private switchingRPC: boolean = false;
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

  public unsubscribe(): void {
    log.info("unsubscribing");
    if (this.listeningProvider) {
      void this.listeningProvider.removeAllListeners();
    }
  }

  public checkHeartbeat(): boolean {
    const blockTime: number = Math.floor((Date.now() - this.lastBlockReceivedAt) / 1_000);
    if (blockTime > this.config.waitForBlockSeconds) {
      log.warn({ receivedSecondsAgo: blockTime }, "Last block received too long ago - heartbeat check failed");
      return false;
    }
    return true;
  }

  private async switchListeningMode(): Promise<void> {
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

    let next: ListeningProvider;
    if (this.mode === ListeningMode.Events || this.config.rpcListenWs.length < 1) {
      log.warn("Switching from Websocket to HTTP provider");
      this.mode = ListeningMode.Polling;
      next = this.httpProvider;
    } else {
      log.warn({ nexRpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() }, "Switching from HTTP to WS");
      this.mode = ListeningMode.Events;
      // startNextWebsocket will be called in health checks, therefore we don't
      // need to do that here.
      next = this.multiUrlWsProvider;
    }
    this.listeningProvider = next;
    this.switchingRPC = false;

    next.resetErrorNumber();

    this.addListeners();
    void this.redisPubClient.publish("switch-mode", this.mode);
  }

  /**
   * Wait for blockNumber to come from WS connection or switch to http on
   * failure.
   */
  private async connectWsOrSwitchToHttp(): Promise<void> {
    this.blockNumber = undefined;
    setTimeout((): void => {
      if (!this.blockNumber) {
        log.warn("websocket connection could not be established");
        void this.switchListeningMode();
      }
    }, this.config.waitForBlockSeconds * 1_000);
    await sleep(this.config.waitForBlockSeconds * 1_000);
  }

  private resetHealthChecks(): void {
    // periodic health checks
    setInterval((): void => {
      if (this.mode === ListeningMode.Events) {
        // currently on WS - check that block time is still reasonable or if we
        // need to switch
        if (!this.checkHeartbeat()) {
          void this.switchListeningMode();
        }
      } else if (this.config.rpcListenWs.length > 0) {
        void this.tryReconnectToWs();
      }
    }, this.config.healthCheckSeconds * 1_000);
  }

  private async tryReconnectToWs(): Promise<void> {
    const observed: { success: boolean } = { success: false };

    await this.multiUrlWsProvider.startNextWebsocket();
    log.info({ rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() }, "attempting to switch to WS");
    const blockReceivedCb = (): void => {
      log.debug({ rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() }, "block received");
      observed.success = true;
    };
    void this.multiUrlWsProvider.on("block", blockReceivedCb);
    setTimeout((): void => {
      this.finishWsReconnectAttempt(observed, blockReceivedCb).catch((err: unknown): void => {
        log.error({ err }, "finishWsReconnectAttempt failed");
      });
    }, this.config.waitForBlockSeconds * 1_000);
  }

  private async finishWsReconnectAttempt(
    observed: { success: boolean },
    blockReceivedCb: () => void,
  ): Promise<void> {
    if (observed.success) {
      await this.multiUrlWsProvider.removeListener("block", blockReceivedCb);
      await this.switchListeningMode();
    } else {
      await this.multiUrlWsProvider.stop();
      log.warn("attempting to switch to WS failed - block not received");
    }
  }

  public containsEthersConnErrors(error: string): boolean {
    const ethersErrors: string[] = [
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

  public async start(): Promise<void> {
    this.network = await executeWithTimeout(
      this.httpProvider.getNetwork(),
      // Use at least 2X timeout of HTTP provider in case some of the rpc are
      // slow to respond.
      40_000,
      "could not establish http connection",
    );

    const result = await initMarketDataWithCache(this.md, [this.httpProvider], this.redisPubClient);
    log.info({ cache: result.usedCache, cacheAgeMs: result.cacheAgeMs }, "sentinel MarketData initialized");

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
      "started",
    );

    this.emergency = new EmergencyPublishedStore();

    void this.connectWsOrSwitchToHttp();
    this.addListeners();
    this.resetHealthChecks();
  }

  private refreshSymbolsCoalesced(): Promise<void> {
    this.refreshSymbolsInFlight ??= this.md.refreshSymbols(true).finally((): void => {
      this.refreshSymbolsInFlight = null;
    });
    return this.refreshSymbolsInFlight;
  }

  private async resolveSymbol(perpId: number): Promise<string | undefined> {
    const cached: string | undefined = this.md.getSymbolFromPerpId(perpId);
    if (cached !== undefined) return cached;
    try {
      await this.refreshSymbolsCoalesced();
    } catch (e: unknown) {
      log.warn({ perpetualId: perpId, error: errMsg(e) }, "refreshSymbolsFailed");
    }
    return this.md.getSymbolFromPerpId(perpId);
  }

  private addListeners(): void {
    const provider: ListeningProvider | undefined = this.listeningProvider;
    if (provider === undefined) {
      throw new Error("No provider ready to listen.");
    }

    // on error terminate
    void provider.on("error", (e: unknown): void => {
      log.error({ err: e, mode: this.mode }, "received error msg");
      // Submit last block received ts to executor/distributor to take action if
      // needed.
      void this.redisPubClient.publish("listener-error", this.lastBlockReceivedAt.toString());

      this.unsubscribe();
      void this.switchListeningMode();
    });

    void provider.on("block", (blockNumber: number): void => {
      this.lastBlockReceivedAt = Date.now();
      this.blockNumber = blockNumber;
    });

    const proxy = IPerpetualManager__factory.connect(this.md.getProxyAddress(), provider);

    void proxy.on(
      proxy.filters.SetEmergencyState,
      (perpetualId: bigint, _r: bigint, _s2: bigint, _s3: bigint, event: unknown): void => {
        void this.handleEmergencyState(perpetualId, readEventLog(event));
      },
    );

    void proxy.on(proxy.filters.SetNormalState, (perpetualId: bigint, event: unknown): void => {
      const perpId: number = Number(perpetualId);
      this.emergency.clear(perpId);
      const lg: EventLogFields = readEventLog(event);
      void this.redisPubClient.publish(
        "PerpNormal",
        JSON.stringify({
          perpetualId: perpId,
          block: lg.blockNumber,
          hash: lg.transactionHash,
          id: `${lg.transactionHash}:${String(lg.index)}`,
        }),
      );
      log.info({ event: "SetNormalState", perpetualId: perpId });
    });
  }

  private async handleEmergencyState(perpetualId: bigint, lg: EventLogFields): Promise<void> {
    const perpId: number = Number(perpetualId);
    // SetEmergency is emitted for a given perp twice.
    // SetEmergency recieved for that perp within the last 10min are ignored.
    if (this.emergency.shouldIgnore(perpId)) return;
    this.emergency.markPublished(perpId);
    const symbol: string | undefined = await this.resolveSymbol(perpId);
    if (symbol === undefined) return;
    const msg: PerpEmergencyMsg = {
      perpetualId: perpId,
      symbol,
      block: lg.blockNumber,
      hash: lg.transactionHash,
      id: `${lg.transactionHash}:${String(lg.index)}`,
    };
    await this.redisPubClient.publish("PerpEmergency", JSON.stringify(msg));
    log.info({ event: "SetEmergencyState", ...msg });
  }
}
