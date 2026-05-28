import { loadConfig, requireEnv } from "../utils.js";
import BlockhainListener from "./blockchainListener.js";
import "dotenv/config";
import { createLogger } from "../logger.js";
import { LiquidatorConfig } from "../types.js";

const log = createLogger("sentinel");

async function start(): Promise<void> {
  const sdkConfig: string = requireEnv("SDK_CONFIG");
  const cfg: LiquidatorConfig = await loadConfig(sdkConfig);
  const eventStreamer: BlockhainListener = new BlockhainListener(cfg);
  await eventStreamer.start();
}

start().catch((err: unknown): void => {
  log.error({ err }, "sentinel exiting with error on startup");
  process.exit(1);
});
