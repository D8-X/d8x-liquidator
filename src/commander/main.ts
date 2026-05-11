import { loadConfig, requireEnv } from "../utils.js";
import Distributor from "./distributor.js";
import "dotenv/config";
import { createLogger } from "../logger.js";
import { LiquidatorConfig } from "../types.js";

const log = createLogger("commander");

async function start(): Promise<void> {
  const sdkConfig: string = requireEnv("SDK_CONFIG");
  const cfg: LiquidatorConfig = await loadConfig(sdkConfig);
  const obj: Distributor = new Distributor(cfg);
  await obj.initialize();
  obj.run();
}

start().catch((err: unknown): void => {
  log.error({ err }, "commander fatal");
  process.exit(1);
});
