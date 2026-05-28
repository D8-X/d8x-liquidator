import Liquidator from "./liquidator.js";
import { LoadedAccounts, loadAccounts, loadConfig, requireEnv, sleep } from "../utils.js";
import "dotenv/config";
import { createLogger } from "../logger.js";
import { LiquidatorConfig } from "../types.js";

const log = createLogger("executor");

async function run(): Promise<void> {
  // sdk config
  const sdkConfig: string = requireEnv("SDK_CONFIG");
  // seed phrase
  const seedPhrase: string = requireEnv("SEED_PHRASE");
  // config
  const cfg: LiquidatorConfig = await loadConfig(sdkConfig);

  // bot treasury
  const {
    pk: [treasuryPK],
  }: LoadedAccounts = loadAccounts(seedPhrase, 0, 0);

  // bot wallets
  const { addr, pk }: LoadedAccounts = loadAccounts(seedPhrase, 1, cfg.bots);
  log.info({ botCount: addr.length, addresses: addr }, "Starting bots");

  const liquidator: Liquidator = new Liquidator(treasuryPK, pk, cfg);

  try {
    await liquidator.fundWallets(addr);
  } catch (_e: unknown) {
    await sleep(60_000);
    process.exit(1);
  }
  await liquidator.initialize();

  await liquidator.run();
}

run().catch((err: unknown): void => {
  log.error({ err }, "executor fatal");
  process.exit(1);
});
