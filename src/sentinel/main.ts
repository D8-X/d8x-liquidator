import { loadConfig } from "../utils.js";
import BlockhainListener from "./blockchainListener.js";
import "dotenv/config";
import { createLogger } from "../logger.js";

const log = createLogger("sentinel");

async function start() {
  const sdkConfig = process.env.SDK_CONFIG;
  if (sdkConfig == undefined) {
    throw new Error(`Environment variable SDK_CONFIG not defined.`);
  }
  const cfg = await loadConfig(sdkConfig);
  const eventStreamer = new BlockhainListener(cfg);
  await eventStreamer.start();
}

start().catch((err) => {
  log.error({ err }, "sentinel exiting with error on startup");
  process.exit(1);
});
