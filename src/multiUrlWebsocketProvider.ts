import {
  SocketProvider,
  Networkish,
  JsonRpcApiProviderOptions,
  ProviderEvent,
  Listener,
  JsonRpcResult,
  JsonRpcError,
} from "ethers";
import { WebSocket, type ErrorEvent, type CloseEvent, type MessageEvent, type Event } from "ws";
import { MultiUrlProvider } from "./multiUrlJsonRpcProvider.js";
import { createLogger } from "./logger.js";
import { errMsg } from "./utils.js";

const log = createLogger("rpc.ws");

export interface MultiUrlWebsocketsProviderOptions extends JsonRpcApiProviderOptions {
  maxRetries?: number;
  // Whether to log the switch of rpc urls. Defaults to false.
  logRpcSwitches?: boolean;
  // Whether to log errors. Defaults to false.
  logErrors?: boolean;
  // Timeout for websocket conn handshake in ms. Defaults to 5000 (5 seconds).
  connTimeout?: number;
}

type InternalOptions = JsonRpcApiProviderOptions & {
  maxRetries: number;
  logRpcSwitches: boolean;
  logErrors: boolean;
  connTimeout: number;
};

interface NotReadyState {
  promise: Promise<void>;
  resolve: (() => void) | null;
}

interface WsErrorEvent extends ErrorEvent {
  error: unknown;
  target: WebSocket;
}

interface WsOpenEvent extends Event {
  target: WebSocket;
}

function wsDataToString(data: MessageEvent["data"]): string {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) {
    return data.map((b: Buffer): string => b.toString("utf8")).join("");
  }
  return data.toString("utf8");
}

/**
 * MultiUrlWebSocketProvider is similar to traditional ethers WebsocketProvider,
 * however it accepts multiple rpc urls and switched to next one in the list in
 * case of failures.
 */
export class MultiUrlWebSocketProvider extends SocketProvider implements MultiUrlProvider {
  // Current active ws instance
  public websocket: WebSocket | null = null;
  // When isStopped is true, the provider will not attempt to switch rpcs or
  // create new connections. Set to true by stop() and on max-retries reached;
  // reset to false by startNextWebsocket().
  private isStopped: boolean = false;

  private rpcUrls: string[] = [];
  // Index of current rpc url in the list. Starts at -1 since we increment it
  // immediately.
  private currentRpcUrlIndex: number = -1;

  // List of event listeners that were registered via this.on. We track this
  // list to recreate any event listeners when switching to a new ws instance.
  private registeredListeners: Map<ProviderEvent, Listener[]> = new Map();
  // Number of errors encountered without a successful connection.
  private currentErrorsNumber: number = 0;
  private options: InternalOptions;
  private starting: boolean = false;

  // See base class implementation. TLDR: prevents _write calls before
  // establishing connection when switching rpcs.
  private notReady: NotReadyState | null = null;

  constructor(rpcUrls: string[], network?: Networkish, options?: MultiUrlWebsocketsProviderOptions) {
    if (rpcUrls.length <= 0) {
      throw new Error("at least one rpc url must be provided");
    }
    super(network, options);
    this.rpcUrls = rpcUrls;
    this.options = {
      maxRetries: rpcUrls.length,
      logRpcSwitches: false,
      logErrors: false,
      connTimeout: 5000,
      ...options,
    };

    this.startNextWebsocket().catch((err: unknown): void => {
      log.error({ err }, "initial startNextWebsocket failed");
    });
  }

  /**
   * (Re)starts the websocket provider with the next rpc url from provided list.
   */
  public async startNextWebsocket(forceCloseOpenConn: boolean = false): Promise<void> {
    if (this.websocket) {
      const rs: number = this.websocket.readyState;
      if (rs === WebSocket.OPEN && !forceCloseOpenConn) return;
      if (rs === WebSocket.CONNECTING) return;
    }
    if (this.starting) return;
    this.starting = true;
    try {
      if (this.notReady?.resolve) {
        this.notReady.resolve();
      }
      let resolve: (() => void) | null = null;
      const promise: Promise<void> = new Promise<void>((_resolve: () => void) => {
        resolve = _resolve;
      });
      this.notReady = { promise, resolve };

      this.isStopped = false;
      if (this.websocket) {
        await this._stop();
      }

      this.switchToNextRpc();
      if (this.options.logRpcSwitches) {
        log.warn({ rpcUrl: this.getCurrentRpcUrl() }, "switching rpc");
      }

      this.startWebsocketEventListeners();
      this.registerPreviousEventListeners();
    } finally {
      this.starting = false;
    }
  }

  private startNextWebsocketIfNotStopped(): void {
    if (!this.isStopped) {
      this.startNextWebsocket(true).catch((err: unknown): void => {
        log.error({ err }, "startNextWebsocket failed");
      });
    }
  }

  /**
   * Re-registers all event listeners that were registered via this.on with
   * previous connection
   */
  private registerPreviousEventListeners(): void {
    const prevListeners: IterableIterator<[ProviderEvent, Listener[]]> = this.registeredListeners.entries();
    for (const [event, listeners] of prevListeners) {
      listeners.forEach((listener: Listener): void => {
        this.on(event, listener).catch((err: unknown): void => {
          log.error({ err, event }, "failed to re-register listener after rpc switch");
        });
      });
    }
  }

  /**
   * Temporarily stop the provider by closing current connection and removing
   * listeners. startNextWebsocket must be called to resume the provider.
   */
  public async stop(): Promise<void> {
    this.isStopped = true;
    this.settleNotReady();
    await this._stop();
  }

  private shutdown(): void {
    this.isStopped = true;
    this.settleNotReady();
    if (this.websocket) {
      this.detachAndCloseWs(this.websocket);
      this.websocket = null;
    }
  }

  private settleNotReady(): void {
    if (this.notReady?.resolve) {
      this.notReady.resolve();
      this.notReady = null;
    }
  }

  private async _stop(): Promise<void> {
    this.pause(true);
    await this.removeAllListeners();
    if (this.websocket) {
      this.detachAndCloseWs(this.websocket);
      this.websocket = null;
    }
  }

  private detachAndCloseWs(ws: WebSocket): void {
    ws.onopen = (): void => undefined;
    ws.onerror = (): void => undefined;
    ws.onmessage = (): void => undefined;
    ws.onclose = (): void => undefined;
    if (ws.readyState <= WebSocket.OPEN) {
      ws.close();
    }
  }

  /**
   * Switch to next rpc in the list and initialize a new websocket instance.
   */
  private switchToNextRpc(): void {
    this.currentRpcUrlIndex = (this.currentRpcUrlIndex + 1) % this.rpcUrls.length;
    this.websocket = this.newWsInstance();
  }

  /**
   * Start WebSocket connection listeners. Websocket instance must be set.
   */
  private startWebsocketEventListeners(): void {
    // This should never happen
    const ws: WebSocket | null = this.websocket;
    if (ws === null) {
      throw new Error("websocket is not initialized");
    }

    ws.onopen = (event: WsOpenEvent): void => {
      if (ws !== this.websocket) return;
      try {
        this._start();
        this.resume();
      } catch (error: unknown) {
        log.error({ err: error }, "failed to start WebsocketProvider");
      }

      if (this.notReady !== null && this.notReady.resolve !== null) {
        this.notReady.resolve();
        this.notReady = null;
      }

      this.currentErrorsNumber = 0;
      if (this.options.logRpcSwitches) {
        log.info({ rpcUrl: event.target.url }, "switched rpc");
      }
    };

    ws.onerror = (data: WsErrorEvent): void => {
      if (ws !== this.websocket) return;
      const error: unknown = data.error;
      const url: string = data.target.url;

      void this.emit("error", error);
      if (this.options.logErrors) {
        log.error({ err: error, reason: errMsg(error), rpcUrl: url }, "connection error");
      }
      if (this.currentErrorsNumber >= this.options.maxRetries) {
        log.error({ rpcUrl: url, reason: errMsg(error) }, "max retries reached; stopping ws provider");
        this.shutdown();
        return;
      }
      this.currentErrorsNumber++;
      this.startNextWebsocketIfNotStopped();
    };

    ws.onclose = (_closeEvent: CloseEvent): void => {
      if (ws !== this.websocket) return;
    };

    ws.onmessage = (event: MessageEvent): void => {
      if (ws !== this.websocket) return;
      const url: string = event.target.url;
      const data: string = wsDataToString(event.data);
      try {
        const result: JsonRpcResult | JsonRpcError = JSON.parse(data) as JsonRpcResult | JsonRpcError;
        if ("error" in result) {
          log.error({ err: result.error, rpcUrl: url }, "received error in message");
          this.startNextWebsocketIfNotStopped();
          return;
        }
      } catch (e: unknown) {
        if (this.options.logErrors) {
          log.error({ err: e, data, rpcUrl: url }, "invalid JSON in message");
        }
        this.startNextWebsocketIfNotStopped();
        return;
      }

      this.currentErrorsNumber = 0;
      void this._processMessage(data);
    };
  }

  /**
   * @returns new Websocket instance with current rpc url.
   */
  private newWsInstance(): WebSocket {
    return new WebSocket(this.getCurrentRpcUrl(), {
      handshakeTimeout: this.options.connTimeout,
    });
  }

  async _write(message: string): Promise<void> {
    await this._waitUntilReady();
    if (!this.websocket) {
      throw new Error("websocket not initialized");
    }
    this.websocket.send(message);
  }

  /**
   * Destroy the provider and close underlying connection. This will render
   * provider unusable and will require to create a new instance.
   */
  public destroy(): void {
    if (this.destroyed) return;
    this.isStopped = true;
    this.settleNotReady();
    if (this.websocket !== null) {
      this.detachAndCloseWs(this.websocket);
      this.websocket = null;
    }
    super.destroy();
  }

  /**
   * @returns the current rpc url
   */
  public getCurrentRpcUrl(): string {
    if (this.currentRpcUrlIndex < 0) {
      throw new Error("ws provider not initialized. getCurrentRpcUrl called before first switchToNextRpc");
    }
    return this.rpcUrls[this.currentRpcUrlIndex];
  }

  /**
   * Base class on override which tracks event listeners whenever we need to
   * create a new ws connection instance.
   * @param event
   * @param listener
   * @returns
   */
  public async on(event: ProviderEvent, listener: Listener): Promise<this> {
    // Only append listener to registered listeners map if it is not already
    // there.
    const existing: Listener[] | undefined = this.registeredListeners.get(event);
    if (existing) {
      if (!existing.includes(listener)) {
        existing.push(listener);
      }
    } else {
      this.registeredListeners.set(event, [listener]);
    }

    return super.on(event, listener);
  }

  /**
   * Base class removeListener override which also cleans up internal
   * MultiUrlWebsocketProvider state for registeredListeners.
   * @param event
   * @param listener
   * @returns
   */
  async off(event: ProviderEvent, listener?: Listener): Promise<this> {
    if (!listener) {
      this.registeredListeners.delete(event);
    } else {
      const listeners: Listener[] | undefined = this.registeredListeners.get(event);
      if (listeners) {
        const i: number = listeners.indexOf(listener);
        if (i !== -1) {
          listeners.splice(i, 1);
        }
        if (listeners.length === 0) {
          this.registeredListeners.delete(event);
        }
      }
    }

    return super.off(event, listener);
  }

  async removeListener(event: ProviderEvent, listener: Listener): Promise<this> {
    return this.off(event, listener);
  }

  /**
   * Reset the number of errors back to 0.
   */
  public resetErrorNumber(): void {
    this.currentErrorsNumber = 0;
  }

  /**
   * Override, because base class uses private fields.
   */
  async _waitUntilReady(): Promise<void> {
    if (this.notReady == null) {
      return;
    }
    await this.notReady.promise;
  }
}
