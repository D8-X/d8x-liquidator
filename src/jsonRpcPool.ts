import { sleep } from "@d8x/perpetuals-sdk";
import {
  FetchRequest,
  FetchResponse,
  JsonRpcApiProvider,
  JsonRpcApiProviderOptions,
  JsonRpcPayload,
  JsonRpcResult,
  Networkish,
} from "ethers";
import { executeWithTimeout } from "./utils";

export interface PoolJsonRpcProviderOptions extends JsonRpcApiProviderOptions {
  // Switch to different rpc on each send call. Defaults to true. Optimal when
  // using a lot of free rpcs.
  switchOnEachCall?: boolean;
  // Timeout in seconds for a single send to complete. This is for entier
  // request/response duration, so make sure to use sane value. Defaults to 30
  // seconds.
  timeoutSeconds?: number;
  // Maximum number of rpc errors until send starts throwing errors. Defaults to
  // number of provided rpc urls.
  maxRetries?: number;
  // Should errors be logged to console. Defaults to false.
  logErrors?: boolean;
  // Whether to console.log the switch of rpc urls. Defaults to false.
  logRpcSwitches?: boolean;
}

/**
 * PooledJsonRpcProvider is a JsonRpcProvider that can switch between multiple RPC
 * URLs if a request fails. Useful when using public rpcs.
 *
 * @see JsonRpcProvider for details
 */
export class PooledJsonRpcProvider extends JsonRpcApiProvider {
  private currentConnection: FetchRequest;
  private options: PoolJsonRpcProviderOptions;
  private rpcUrls: string[] = [];
  private currentRpcUrlIndex: number = 0;
  // Resets when a request is successful
  private currentNumberOfErrors: number = 0;

  constructor(rpcUrls: string[], network?: Networkish, options?: PoolJsonRpcProviderOptions) {
    if (rpcUrls.length <= 0) {
      throw new Error("at least one rpc url must be provided");
    }

    super(network, options);
    // Setup options with sane defaults
    this.options = {
      switchOnEachCall: true,
      timeoutSeconds: 30,
      maxRetries: rpcUrls.length,
      logErrors: false,
      logRpcSwitches: false,
      ...options,
    };
    this.rpcUrls = rpcUrls;

    // Initialize to the first url in the list
    this.currentConnection = new FetchRequest(rpcUrls[0]);
  }

  _getConnection(): FetchRequest {
    return this.currentConnection.clone();
  }

  async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    await this._start();
    return await super.send(method, params);
  }

  /**
   * Use the next rpc in list, increment errors counter and initialize new
   * request conn.
   */
  switchRpcOnError() {
    // Do not switch rpc if we have automatic switch enabled, since the next
    // send will automatically switch to next rpc. If we switched here, we would
    // always skip 2 rpcs.
    if (!this.options.switchOnEachCall) {
      this.switchRpc();
    }

    this.currentNumberOfErrors++;
  }

  /**
   * Simply switch to the next rpc in the list.
   */
  private switchRpc() {
    this.currentRpcUrlIndex = (this.currentRpcUrlIndex + 1) % this.rpcUrls.length;
    this.currentConnection = new FetchRequest(this.getCurrentRpcUrl());

    if (this.options.logRpcSwitches) {
      console.log(`[PooledJsonRpcProvider] switched rpc from to ${this.getCurrentRpcUrl()}`);
    }
  }

  /**
   * Send the payload as in JsonRpcProvider, but switch rpc and retry if the
   * request fails. If we reached the maximum number of retries, throw the last
   * error.
   * @param payload
   * @returns
   */
  async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    if (this.options.switchOnEachCall) {
      this.switchRpc();
    }

    const request = this._getConnection();
    request.body = JSON.stringify(payload);
    request.setHeader("content-type", "application/json");

    let response: FetchResponse | undefined;
    const currentRpcUrl = this.getCurrentRpcUrl();
    try {
      // Timeout in ethers request is not actually treated as a real timeout for
      // a single send, but rather more like a timeout if same request has to be
      // sent multiple times or follow redirects... See the source of
      // request.send(). Here we set up a real timeout for a single request to complete.
      await executeWithTimeout(
        (async () => {
          response = await request.send();
        })(),
        this.options.timeoutSeconds! * 1000
      );

      if (response !== undefined) {
        response.assertOk();
      }
    } catch (err) {
      if (this.options.logErrors) {
        console.error(`[PooledJsonRpcProvider@${currentRpcUrl}] request error: `, err);
      }
      this.switchRpcOnError();

      // When max number of errors is reached - throw.
      if (this.currentNumberOfErrors >= this.options.maxRetries!) {
        throw err;
      }

      return this._send(payload);
    }

    let resp = response!.bodyJson;
    if (!Array.isArray(resp)) {
      resp = [resp];
    }

    // JSON-RPC error might be returned inside a correct response. Check for it.
    if (resp.length > 0 && Object.hasOwnProperty.call(resp[0], "error")) {
      if (this.options.logErrors) {
        console.error(`[PooledJsonRpcProvider@${currentRpcUrl}] JSON-RPC response error: `, resp[0].error);
      }
      this.switchRpcOnError();
      return this._send(payload);
    }

    // Request was sent successfuly, reset errors counter
    this.currentNumberOfErrors = 0;

    return resp;
  }

  getCurrentRpcUrl(): string {
    return this.rpcUrls[this.currentRpcUrlIndex];
  }
}
