import { loadConfig } from "../utils";
import Distributor from "./distributor";

require("dotenv").config();

async function start() {
  const sdkConfig = process.env.SDK_CONFIG;
  if (sdkConfig == undefined) {
    throw new Error(`Environment variable SDK_CONFIG not defined.`);
  }
  const cfg = loadConfig(sdkConfig);
  const obj = new Distributor(cfg);
  await obj.initialize();
  obj.run();
}

start();
