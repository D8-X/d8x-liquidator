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
  await eventStreamer.start();
}

start().catch((err) => {
  console.error(
    `${new Date().toISOString()}: sentinel fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`
  );
  process.exit(1);
});
