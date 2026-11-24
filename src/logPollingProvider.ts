import { EventFilter, Subscriber, Subscription } from "ethers";
import { MultiUrlJsonRpcProvider } from "./multiUrlJsonRpcProvider.js";
import { createLogger } from "./logger.js";

const log = createLogger("logPollingProvider");

const LOG_POLL_INTERVAL_MS = 4_000;
const LOG_POLL_LAG_BLOCKS = 10;
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
  private nextBlock?: number;
  private range = MAX_LOG_POLL_BLOCKS;

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
      this.nextBlock = undefined;
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
    try {
      const head = await this.provider.getBlockNumber();
      if (this.nextBlock === undefined) {
        this.nextBlock = head + 1;
        return;
      }
      const fromBlock = this.nextBlock;
      const toBlock = Math.min(head - LOG_POLL_LAG_BLOCKS, fromBlock + this.range - 1);
      if (toBlock < fromBlock) {
        return;
      }
      const logs = await this.provider.getLogs({ ...this.filter, fromBlock, toBlock });
      for (const entry of logs) {
        void this.provider.emit(this.filter, entry);
      }
      this.nextBlock = toBlock + 1;
      this.range = MAX_LOG_POLL_BLOCKS;
    } catch (e) {
      this.range = Math.max(1, Math.floor(this.range / 2));
      log.warn({ err: e, nextRange: this.range }, "log poll failed");
    } finally {
      this.inflight = false;
    }
  }
}
