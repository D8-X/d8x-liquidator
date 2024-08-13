import { JsonRpcProvider } from "ethers";
import { executeWithTimeout } from "../utils";

export default class RPCManager {
  private healthy: Map<string, boolean> = new Map();
  private lastCheck: Map<string, number> = new Map();

  private CHECK_INTERVAL_MS = 4_000_000;
  private NETWORK_READY_MS = 10_000;

  /**
   * @param rpcURLs Array of RPC URLs
   */
  constructor(private rpcURLs: string[]) {}

  /**
   * Finds the next RPC in the queue and returns it. Health check is enabled by default.
   * @returns An RPC URL
   */
  public async getRPC(healthy: boolean = true): Promise<string> {
    if (this.rpcURLs.length < 1) {
      throw new Error("No RPCs in queue");
    }
    let numTries = 0;
    while (numTries < this.rpcURLs.length) {
      numTries++;
      const rpc = await this.cycleRPCs();
      if (!healthy || this.healthy.get(rpc)) {
        return rpc;
      }
    }
    throw new Error("No healthy RPCs");
  }

  /**
   * Adds an RPC to the list
   * @param rpc An RPC URL
   */
  public addRPC(rpc: string) {
    this.rpcURLs.push(rpc);
  }

  /**
   * Cycles the list of RPC URLs and returns the next in line,
   * updaing its health status if necessary
   * @returns The next RPC URL
   */
  private async cycleRPCs() {
    const rpc = this.rpcURLs.pop();
    if (rpc === undefined) {
      throw new Error("No RPCs in queue");
    }
    if (this.healthy.get(rpc) === undefined || (this.lastCheck.get(rpc) ?? 0) + this.CHECK_INTERVAL_MS < Date.now()) {
      const provider = new JsonRpcProvider(rpc);
      try {
        await executeWithTimeout(provider._detectNetwork(), this.NETWORK_READY_MS);
        this.healthy.set(rpc, true);
      } catch (_e) {
        this.healthy.set(rpc, false);
      }
      this.lastCheck.set(rpc, Date.now());
    }
    this.rpcURLs = [rpc, ...this.rpcURLs];
    return rpc;
  }
}
