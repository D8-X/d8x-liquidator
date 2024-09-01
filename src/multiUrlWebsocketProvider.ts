import {
  SocketProvider,
  WebSocketLike,
  WebSocketCreator,
  Networkish,
  JsonRpcApiProviderOptions,
  ProviderEvent,
  Listener,
  JsonRpcResult,
  JsonRpcError,
} from "ethers";
import { WebSocket } from "ws";
import { MultiUrlProvider } from "./multiUrlJsonRpcProvider";

export interface MultiUrlWebsocketsProviderOptions extends JsonRpcApiProviderOptions {
  maxRetries?: number;
  // Whether to console.log the switch of rpc urls. Defaults to false.
  logRpcSwitches?: boolean;
  // Whether to console.log errors. Defaults to false.
  logErrors?: boolean;
}

/**
 * MultiUrlWebSocketProvider is similar to traditional ethers WebsocketProvider,
 * however it accepts multiple rpc urls and switched to next one in the list in
 * case of failures.
 */
export class MultiUrlWebSocketProvider extends SocketProvider implements MultiUrlProvider {
  // Current active ws instance
  public websocket: WebSocket | null = null;
  // When isStopped is true, it will not attempt to switch rpcs or create new
  // connections. It can only be set to false by calling stop manually.
  private isStopped = false;

  private rpcUrls: string[] = [];
  // Index of current rpc url in the list. Starts at -1 since we increment it
  // immediately.
  private currentRpcUrlIndex: number = -1;

  // List of event listeners that were registered via this.on. We track this
  // list to recreate any event listeners when switching to a new ws instance.
  private registeredListeners: Array<[ProviderEvent, Listener]> = [];
  // Number of errors encountered without a successful connection.
  private currentErrorsNumber = 0;
  private options: MultiUrlWebsocketsProviderOptions;

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

      ...options,
    };

    this.startNextWebsocket();
  }

  /**
   * (Re)starts the websocket provider with the next rpc url from provided list.
   */
  public async startNextWebsocket() {
    this.isStopped = false;
    // Close current connection if it is established, gracefully remove any
    // event listeners and close the underlying ws conn.
    if (this.websocket) {
      await this._stop();
    }

    this.switchToNextRpc();

    if (this.options.logRpcSwitches) {
      console.log(
        `[(${new Date().toISOString()}) MultiUrlWebSocketProvider] switching rpc to ${this.getCurrentRpcUrl()}`
      );
    }

    this.startWebsocketEventListeners();
    this.registerPreviousEventListeners();
  }

  private async startNextWebsocketIfNotStopped() {
    if (!this.isStopped) {
      await this.startNextWebsocket();
    }
  }

  /**
   * Re-registers all event listeners that were registered via this.on with
   * previous connection
   */
  private registerPreviousEventListeners() {
    this.registeredListeners.forEach(([event, listener]) => {
      this.on(event, listener);
    });
  }

  /**
   * Temporarily stop the provider by closing current connection and removing
   * listeners. startNextWebsocket must be called to resume the provider.
   */
  public async stop() {
    this.isStopped = true;
    await this._stop();
  }

  private async _stop() {
    this.pause(true);
    await this.removeAllListeners();
    if (this.websocket) {
      if (this.websocket.readyState <= WebSocket.OPEN) {
        this.websocket.close();
      }
    }
  }

  /**
   * Switch to next rpc in the list and initialize a new websocket instance.
   */
  private switchToNextRpc() {
    this.currentRpcUrlIndex = (this.currentRpcUrlIndex + 1) % this.rpcUrls.length;
    this.websocket = this.newWsInstance();
  }

  /**
   * Start WebSocket connection listeners. Websocket instance must be set.
   */
  private startWebsocketEventListeners() {
    // This should never happen
    if (this.websocket === null) {
      throw Error("websocket is not initialized");
    }

    // Copy from ethers.WebSocketProvider
    this.websocket.onopen = async () => {
      try {
        await this._start();
        this.resume();
      } catch (error) {
        console.log("failed to start WebsocketProvider", error);
      }

      this.currentErrorsNumber = 0;
    };

    this.websocket.onerror = (data) => {
      const { error } = data;
      this.emit("error", error);
      // Connection failure, attempt to switch to next rpc url
      // console.log("got websocket error", error, this.websocket.readyState);
      if (this.options.logErrors) {
        console.log(
          `[(${new Date().toISOString()}) MultiUrlWebSocketProvider@${this.getCurrentRpcUrl()}] Connection error:`,
          error
        );
      }
      if (this.currentErrorsNumber >= this.options.maxRetries!) {
        console.error(`[(${new Date().toISOString()}) MultiUrlWebSocketProvider] Max retries reached`);
        throw error;
      }
      this.currentErrorsNumber++;
      this.startNextWebsocketIfNotStopped();
    };

    this.websocket.onclose = (closeEvent) => {
      // @TODO handle potential closes. One caveat is that we close the old
      // websocket connection on switch, so if we just blindly switched here, we
      // might introduce an infinite loop of switching websocket conns.
    };

    this.websocket.onmessage = (message) => {
      const data: string = message.data as string;
      // Check if message does not contain errors
      try {
        const result = <JsonRpcResult | JsonRpcError>JSON.parse(data);
        if ("error" in result) {
          console.log(
            `[(${new Date().toISOString()}) MultiUrlWebSocketProvider@${this.getCurrentRpcUrl()}] Received error in message:`,
            result.error
          );
          this.startNextWebsocketIfNotStopped();
          return;
        }
      } catch (e) {
        if (this.options.logErrors) {
          console.log(
            `[(${new Date().toISOString()}) MultiUrlWebSocketProvider@${this.getCurrentRpcUrl()}] Invalid JSON in message:`,
            data
          );
          this.startNextWebsocketIfNotStopped();
        }
        return;
      }

      // Reset error counter on successful message
      this.currentErrorsNumber = 0;
      this._processMessage(data);
    };
  }

  /**
   * @returns new Websocket instance with current rpc url.
   */
  private newWsInstance(): WebSocket {
    return new WebSocket(this.getCurrentRpcUrl());
  }

  async _write(message: string): Promise<void> {
    this.websocket!.send(message);
  }

  /**
   * Destroy the provider and close underlying connection. This will render
   * provider unusable and will require to create a new instance.
   */
  public async destroy(): Promise<void> {
    if (this.websocket !== null) {
      if (this.websocket.readyState <= WebSocket.OPEN) {
        this.websocket.close();
      }
      this.websocket = null;
    }
    super.destroy();
  }

  /**
   * @returns the current rpc url
   */
  public getCurrentRpcUrl(): string {
    return this.rpcUrls[this.currentRpcUrlIndex];
  }

  /**
   * Base class on override which tracks event listeners whenever we need to
   * create a new ws connection instance.
   * @param event
   * @param listener
   * @returns
   */
  public async on(event: ProviderEvent, listener: Listener) {
    this.registeredListeners.push([event, listener]);
    return super.on(event, listener);
  }

  /**
   * Reset the number of errors back to 0.
   */
  public resetErrorNumber() {
    this.currentErrorsNumber = 0;
  }
}
