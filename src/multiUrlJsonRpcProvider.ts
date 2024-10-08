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

// Common methods among multi url providers
export interface MultiUrlProvider {
  getCurrentRpcUrl(): string;
  resetErrorNumber(): void;
}

export interface MultiUrlJsonRpcProviderOptions extends JsonRpcApiProviderOptions {
  // Switch to different rpc on each send call. Defaults to false. Optimal when
  // using a lot of free rpcs. If set to true, the rpc will switch on each send.
  switchRpcOnEachRequest?: boolean;
  // Timeout in seconds for a single send to complete. This is for entier
  // request/response duration, so make sure to use sane value. Defaults to 30
  // seconds.
  timeoutSeconds?: number;
  // Maximum number of rpc errors until send starts throwing errors. Defaults to
  // number of provided rpc urls.
  maxRetries?: number;
  // Whether to console.log errors. Defaults to false.
  logErrors?: boolean;
  // Whether to console.log the switch of rpc urls. Defaults to false.
  logRpcSwitches?: boolean;
}

/**
 * MultiUrlJsonRpcProvider is a JsonRpcProvider that switches between multiple
 * RPC URLs if a request fails. This provided is useful when using multiple
 * public or unrelialble rpcs which fail frequently or get rate limited.
 *
 * @see JsonRpcApiProvider for more details
 */
export class MultiUrlJsonRpcProvider extends JsonRpcApiProvider implements MultiUrlProvider {
  private currentConnection: FetchRequest;
  private options: MultiUrlJsonRpcProviderOptions;
  private rpcUrls: string[] = [];
  private currentRpcUrlIndex: number = 0;
  // Resets when a request is successful
  private currentNumberOfErrors: number = 0;

  constructor(rpcUrls: string[], network?: Networkish, options?: MultiUrlJsonRpcProviderOptions) {
    if (rpcUrls.length <= 0) {
      throw new Error("at least one rpc url must be provided");
    }

    super(network, options);

    // Setup options with sane defaults
    this.options = {
      switchRpcOnEachRequest: false,
      timeoutSeconds: 30,
      maxRetries: rpcUrls.length,
      logErrors: false,
      logRpcSwitches: false,
      // Override with user provided options
      ...options,
    };
    this.rpcUrls = rpcUrls;

    // Initialize to the first url in the list
    this.currentConnection = new FetchRequest(rpcUrls[0]);
  }

  public _getConnection(): FetchRequest {
    return this.currentConnection.clone();
  }

  async send(method: string, params: Array<any> | Record<string, any>): Promise<any> {
    await this._start();
    return await super.send(method, params);
  }

  /**
   * Use the next rpc url in the list, increment errors counter.
   */
  private switchRpcOnError() {
    // Do not switch rpc if we have automatic switch enabled, since the next
    // send will automatically switch to next rpc. If we had switched here, we
    // would always skip 2 rpcs.
    if (!this.options.switchRpcOnEachRequest) {
      this.switchRpc();
    }

    this.currentNumberOfErrors++;
  }

  /**
   * Simply switch to the next rpc in the list.
   */
  public switchRpc() {
    this.currentRpcUrlIndex = (this.currentRpcUrlIndex + 1) % this.rpcUrls.length;
    this.currentConnection = new FetchRequest(this.getCurrentRpcUrl());

    if (this.options.logRpcSwitches) {
      console.log(
        `[(${new Date().toISOString()}) MultiUrlJsonRpcProvider]  switched rpc to ${this.getCurrentRpcUrl()}`
      );
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
    if (this.options.switchRpcOnEachRequest) {
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
        console.error(`[(${new Date().toISOString()}) MultiUrlJsonRpcProvider@${currentRpcUrl}] request error: `, err);
      }
      this.switchRpcOnError();

      // When max number of errors is reached - throw.
      if (this.currentNumberOfErrors >= this.options.maxRetries!) {
        console.error(`[(${new Date().toISOString()}) MultiUrlJsonRpcProvider@${currentRpcUrl}] Max retries reached`);
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
        console.error(
          `[(${new Date().toISOString()}) MultiUrlJsonRpcProvider@${currentRpcUrl}] JSON-RPC response error: `,
          resp[0].error
        );
      }
      this.switchRpcOnError();
      return this._send(payload);
    }

    // Request was sent successfuly, reset errors counter
    this.currentNumberOfErrors = 0;

    return resp;
  }

  /**
   * @returns the current rpc url
   */
  public getCurrentRpcUrl(): string {
    return this.rpcUrls[this.currentRpcUrlIndex];
  }

  /**
   * Reset the number of errors back to 0.
   */
  public resetErrorNumber(): void {
    this.currentNumberOfErrors = 0;
  }
}
