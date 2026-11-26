import { IPerpetualManager__factory, MarketData, PerpetualDataHandler } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";
import { LiquidatorConfig, PerpEmergencyMsg } from "../types.js";
import { constructRedis, executeWithTimeout, sleep } from "../utils.js";

import { Log, Network, ZeroAddress } from "ethers";
import { MultiUrlJsonRpcProvider } from "../multiUrlJsonRpcProvider.js";
import { MultiUrlWebSocketProvider } from "../multiUrlWebsocketProvider.js";
import { LogPollingJsonRpcProvider } from "../logPollingProvider.js";
import { initMarketDataWithCache } from "../sdkInit.js";
import { EmergencyPublishedStore } from "./emergencyPublishedStore.js";
import { createLogger } from "../logger.js";

const log = createLogger("sentinel.listener");

enum ListeningMode {
  Polling = "Polling",
  Events = "Events",
}

const HEAD_POLL_INTERVAL_MS = 10_000;
const HEAD_POLL_TIMEOUT_MS = 8_000;
const DELIVERY_CHECK_TIMEOUT_MS = 20_000;
const PROBE_ATTEMPT_TIMEOUT_MS = 5_000;
const DELIVERY_CHECK_LAG_BLOCKS = 10;
const DELIVERY_CHECK_MAX_BLOCKS = 2_000;

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
  private switchingRPC = false;
  private headPollTimer?: NodeJS.Timeout;
  private headPollsInflight = new Set<MultiUrlJsonRpcProvider | MultiUrlWebSocketProvider>();
  private proxyInterface = IPerpetualManager__factory.createInterface();
  private deliveredLogs = new Map<string, number>();
  private deliveryCheckFromBlock?: number;
  private emergency!: EmergencyPublishedStore;
  private refreshSymbolsInFlight: Promise<void> | null = null;

  constructor(config: LiquidatorConfig) {
    if (config.rpcListenHttp.length <= 0) {
      throw new Error("Please specify at least one HTTP RPC URL in rpcListenHttp configuration field");
    }

    this.config = config;
    this.md = new MarketData(PerpetualDataHandler.readSDKConfig(this.config.sdkConfig));
    this.redisPubClient = constructRedis("sentinelPubClient");
    this.httpProvider = new LogPollingJsonRpcProvider(this.config.rpcListenHttp, this.md.network, {
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
    return true;
  }

  private startHeadPolling() {
    if (this.headPollTimer) {
      clearInterval(this.headPollTimer);
    }
    const intervalMs = Math.min(HEAD_POLL_INTERVAL_MS, (this.config.waitForBlockSeconds * 1_000) / 4);
    this.headPollTimer = setInterval(() => void this.pollHead(), intervalMs);
    void this.pollHead();
  }

  private async pollHead() {
    const provider = this.listeningProvider;
    if (
      provider === undefined ||
      this.mode === ListeningMode.Polling ||
      this.switchingRPC ||
      this.headPollsInflight.has(provider)
    ) {
      return;
    }
    this.headPollsInflight.add(provider);
    try {
      const blockNumber = await executeWithTimeout(provider.getBlockNumber(), HEAD_POLL_TIMEOUT_MS, "head poll timeout");
      if (provider !== this.listeningProvider || this.switchingRPC) {
        return;
      }
      if (this.blockNumber === undefined || blockNumber > this.blockNumber) {
        this.lastBlockReceivedAt = Date.now();
        this.blockNumber = blockNumber;
      }
    } catch (e) {
      if (provider === this.listeningProvider) {
        log.warn({ err: e, mode: this.mode }, "head poll failed");
      }
    } finally {
      this.headPollsInflight.delete(provider);
    }
  }

  private async switchListeningMode() {
    if (this.switchingRPC) {
      log.warn("already switching RPC");
      return;
    }

    this.blockNumber = undefined;
    this.switchingRPC = true;
    this.deliveredLogs.clear();
    this.deliveryCheckFromBlock = undefined;

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
    void this.pollHead();
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
        if (!this.checkHeartbeat() || !(await this.subscriptionsDelivered())) {
          this.switchListeningMode();
        }
      } else if (this.config.rpcListenWs.length > 0) {
        // currently on HTTP - check if we can switch to WS by seeing if we get
        // blocks with next WS connection.
        // await this.multiUrlWsProvider.startNextWebsocket(); Do not use once
        // with MultiUrlWebsocketProvider. Also, do not call
        // startNextWebsocket(), multi url provider will handle the switching
        // internally
        await this.multiUrlWsProvider.startNextWebsocket();
        log.info(
          { rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() },
          "attempting to switch to WS"
        );
        const probeOk = await this.probeWebsocket();
        if (this.mode !== ListeningMode.Polling || this.switchingRPC) {
          return;
        }
        if (probeOk) {
          await this.switchListeningMode();
        } else {
          // Otherwise just stop the multi url ws provider and try again later
          await this.multiUrlWsProvider.stop();
          log.warn("attempting to switch to WS failed - probe failed");
        }
      }
    }, this.config.healthCheckSeconds * 1_000);
  }

  private recordDelivered(event: any) {
    if (this.mode === ListeningMode.Events && event?.log) {
      this.deliveredLogs.set(`${event.log.blockHash}:${event.log.index}`, event.log.blockNumber);
    }
  }

  private async subscriptionsDelivered(): Promise<boolean> {
    if (this.blockNumber === undefined) {
      return true;
    }
    const toBlock = this.blockNumber - DELIVERY_CHECK_LAG_BLOCKS;
    if (this.deliveryCheckFromBlock === undefined) {
      this.deliveryCheckFromBlock = toBlock + 1;
      return true;
    }
    if (toBlock < this.deliveryCheckFromBlock) {
      return true;
    }
    const fromBlock = Math.max(this.deliveryCheckFromBlock, toBlock - DELIVERY_CHECK_MAX_BLOCKS + 1);
    const topics = [
      [
        this.proxyInterface.getEvent("SetEmergencyState").topicHash,
        this.proxyInterface.getEvent("SetNormalState").topicHash,
      ],
    ];
    let logs: Log[];
    try {
      logs = await executeWithTimeout(
        this.httpProvider.getLogs({ address: this.md.getProxyAddress(), topics, fromBlock, toBlock }),
        DELIVERY_CHECK_TIMEOUT_MS,
        "delivery check timeout",
      );
    } catch (e) {
      log.warn({ err: e, fromBlock, toBlock }, "delivery check failed");
      return true;
    }
    if (this.mode !== ListeningMode.Events || this.switchingRPC || this.deliveryCheckFromBlock === undefined) {
      return true;
    }
    if (fromBlock > this.deliveryCheckFromBlock) {
      log.warn(
        { fromBlock: this.deliveryCheckFromBlock, toBlock: fromBlock - 1 },
        "delivery check skipped blocks",
      );
    }
    this.deliveryCheckFromBlock = toBlock + 1;
    const missed = logs.filter((l) => !this.deliveredLogs.has(`${l.blockHash}:${l.index}`));
    for (const [key, block] of this.deliveredLogs) {
      if (block <= toBlock) {
        this.deliveredLogs.delete(key);
      }
    }
    if (missed.length > 0) {
      log.warn(
        { missed: missed.length, firstTx: missed[0].transactionHash, fromBlock, toBlock },
        "websocket did not deliver logs",
      );
      return false;
    }
    return true;
  }

  private async probeWebsocket(): Promise<boolean> {
    const deadline = Date.now() + this.config.waitForBlockSeconds * 1_000;
    const remainingMs = () => Math.max(1, deadline - Date.now());
    for (;;) {
      try {
        await executeWithTimeout(
          this.multiUrlWsProvider.getBlockNumber(),
          Math.min(PROBE_ATTEMPT_TIMEOUT_MS, remainingMs()),
          "websocket probe timeout",
        );
        break;
      } catch (e) {
        if (Date.now() >= deadline) {
          log.warn({ err: e, rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() }, "websocket probe failed");
          return false;
        }
        await sleep(Math.min(1_000, remainingMs()));
      }
    }
    try {
      const subId: string = await executeWithTimeout(
        this.multiUrlWsProvider.send("eth_subscribe", ["logs", { address: ZeroAddress }]),
        remainingMs(),
        "websocket subscribe probe timeout",
      );
      await executeWithTimeout(
        this.multiUrlWsProvider.send("eth_unsubscribe", [subId]),
        remainingMs(),
        "websocket unsubscribe probe timeout",
      );
      return true;
    } catch (e) {
      log.warn({ err: e, rpcUrl: this.multiUrlWsProvider.getCurrentRpcUrl() }, "websocket probe failed");
      return false;
    }
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
    this.startHeadPolling();
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

    const proxy = IPerpetualManager__factory.connect(this.md.getProxyAddress(), this.listeningProvider);

    proxy.on(
      proxy.filters.SetEmergencyState,
      async (perpetualId: bigint, _r: bigint, _s2: bigint, _s3: bigint, event: any) => {
        this.recordDelivered(event);
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
      this.recordDelivered(event);
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
