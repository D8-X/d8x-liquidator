import { EventFilter, Subscriber, Subscription } from "ethers";
import { MultiUrlJsonRpcProvider } from "./multiUrlJsonRpcProvider.js";
import { createLogger } from "./logger.js";

const log = createLogger("logPollingProvider");

const LOG_POLL_INTERVAL_MS = 4_000;
const LOG_POLL_LAG_BLOCKS = 2;
const LOG_POLL_OVERLAP_BLOCKS = 30;
const MAX_LOG_POLL_BLOCKS = 1_000;

export class LogPollingJsonRpcProvider extends MultiUrlJsonRpcProvider {
  override _getSubscriber(sub: Subscription): Subscriber {
    if (sub.type === "event") {
      return new IntervalLogSubscriber(this, sub.filter);
    }
    return super._getSubscriber(sub);
  }
}

class IntervalLogSubscriber implements Subscriber {
  private timer?: NodeJS.Timeout;
  private inflight = false;
  private startBlock?: number;
  private nextBlock?: number;
  private range = MAX_LOG_POLL_BLOCKS;
  private seen = new Map<string, number>();

  constructor(
    private provider: LogPollingJsonRpcProvider,
    private filter: EventFilter,
  ) {}

  start() {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => void this.poll(), LOG_POLL_INTERVAL_MS);
    void this.poll();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  pause(dropWhilePaused?: boolean) {
    this.stop();
    if (dropWhilePaused) {
      this.startBlock = undefined;
      this.nextBlock = undefined;
      this.seen.clear();
    }
  }

  resume() {
    this.start();
  }

  private async poll() {
    if (this.inflight) {
      return;
    }
    this.inflight = true;
    let fromBlock: number | undefined;
    let toBlock: number | undefined;
    try {
      const head = await this.provider.getBlockNumber();
      if (this.startBlock === undefined || this.nextBlock === undefined) {
        this.startBlock = head + 1;
        this.nextBlock = head + 1;
        return;
      }
      fromBlock = Math.max(
        this.startBlock,
        this.nextBlock - Math.min(LOG_POLL_OVERLAP_BLOCKS, Math.floor(this.range / 2)),
      );
      toBlock = Math.min(head - LOG_POLL_LAG_BLOCKS, fromBlock + this.range - 1);
      if (toBlock < this.nextBlock) {
        return;
      }
      const logs = await this.provider.getLogs({ ...this.filter, fromBlock, toBlock });
      for (const entry of logs) {
        const key = `${entry.blockHash}:${entry.index}`;
        if (this.seen.has(key)) {
          continue;
        }
        this.seen.set(key, entry.blockNumber);
        void this.provider.emit(this.filter, entry);
      }
      this.nextBlock = toBlock + 1;
      for (const [key, block] of this.seen) {
        if (block < this.nextBlock - LOG_POLL_OVERLAP_BLOCKS) {
          this.seen.delete(key);
        }
      }
      this.range = Math.min(MAX_LOG_POLL_BLOCKS, this.range * 2);
    } catch (e) {
      this.range = Math.max(1, Math.floor(this.range / 2));
      log.warn(
        {
          err: e,
          request: fromBlock === undefined ? "eth_blockNumber" : "eth_getLogs",
          fromBlock,
          toBlock,
          nextRange: this.range,
        },
        "log poll failed",
      );
    } finally {
      this.inflight = false;
    }
  }
}
