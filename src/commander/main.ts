import { loadConfig } from "../utils.js";
import Distributor from "./distributor.js";
import "dotenv/config";

async function start() {
  const sdkConfig = process.env.SDK_CONFIG;
  if (sdkConfig == undefined) {
    throw new Error(`Environment variable SDK_CONFIG not defined.`);
  }
  const cfg = await loadConfig(sdkConfig);
  const obj = new Distributor(cfg);
  await obj.initialize();
  obj.run();
}

start();
