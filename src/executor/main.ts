import { BigNumber, ethers } from "ethers";
import Liquidator from "./liquidator";
import { loadAccounts, loadConfig, sleep } from "../utils";

require("dotenv").config();

async function run() {
  // sdk config
  const sdkConfig = process.env.SDK_CONFIG;
  if (sdkConfig == undefined) {
    throw new Error(`Environment variable SDK_CONFIG not defined.`);
  }
  // seed phrase
  const seedPhrase = process.env.SEED_PHRASE;
  if (seedPhrase == undefined) {
    throw new Error(`Environment variable SEED_PHRASE not defined.`);
  }
  // config
  const cfg = loadConfig(sdkConfig);

  // args: from-to
  const args = process.argv.slice(2);

  const from = Number(args[0] ?? 1);
  const to = Number(args[1] ?? 2);

  // bot treasury
  const {
    addr: [treasuryAddr],
    pk: [treasuryPK],
  } = loadAccounts(seedPhrase, 0, 0);

  // bot wallets
  const { addr, pk } = loadAccounts(seedPhrase, from, to);
  console.log(`\nStarting ${addr.length} bots with addresses ${addr.join("\n")}`);

  // TODO: balance checks and transfers

  const liquidator = new Liquidator(treasuryPK, pk, cfg);
  await liquidator.initialize();
  await liquidator.fundWallets(addr);
  liquidator.run();
}

run();
