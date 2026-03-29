import { loadConfig } from "../utils.js";
import BlockhainListener from "./blockchainListener.js";
import "dotenv/config";

async function start() {
  const sdkConfig = process.env.SDK_CONFIG;
  if (sdkConfig == undefined) {
    throw new Error(`Environment variable SDK_CONFIG not defined.`);
  }
  const cfg = await loadConfig(sdkConfig);
  const eventStreamer = new BlockhainListener(cfg);
  eventStreamer.start();
}

start();
