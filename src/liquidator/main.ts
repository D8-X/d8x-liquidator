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

  const liquidator = new Liquidator(pk, cfg);
  await liquidator.initialize();
  liquidator.run();

  // try {
  //   const bots = new Liquidator(pk, cfg);
  //   await bots.initialize();
  //   bots.run();

  //   const treasury = new ethers.Wallet(treasuryPK, provider);
  //   // min balance should cover 1e7 gas
  //   const minBalance = ethers.utils.parseUnits(`${config.maxGasPriceGWei * 1e7}`, "gwei");
  //   for (let relayerAddr of addr) {
  //     const relayerBalance = await provider.getBalance(relayerAddr);
  //     console.log(
  //       `Relayer (${relayerAddr}) balance: ${ethers.utils.formatUnits(relayerBalance)} ETH (or native token)`
  //     );
  //     const treasuryBalance = await provider.getBalance(treasuryAddr);
  //     console.log(
  //       `Treasury (${treasuryAddr}) balance: ${ethers.utils.formatUnits(treasuryBalance)} ETH (or native token)`
  //     );
  //     console.log(`Minimum balance: ${ethers.utils.formatUnits(minBalance)} ETH (or native token)`);
  //     if (relayerBalance.lt(minBalance)) {
  //       // transfer twice the min so it doesn't transfer every time
  //       const transferAmount = minBalance.mul(2).sub(relayerBalance);
  //       if (transferAmount.lt(treasuryBalance)) {
  //         console.log(`Funding relayer with ${ethers.utils.formatUnits(transferAmount)} tokens...`);
  //         const tx = await treasury.sendTransaction({
  //           to: relayerAddr,
  //           value: transferAmount,
  //         });
  //         console.log(`Transferring tokens - tx hash: ${tx.hash}`);
  //         await tx.wait();
  //         console.log(
  //           `Successfully transferred ${ethers.utils.formatUnits(
  //             transferAmount
  //           )} ETH (or native token) from treasury to relayer ${relayerAddr}`
  //         );
  //       } else {
  //         // TODO: notify a human
  //         throw new Error(
  //           `CRITICAL: insufficient balance in treasury ${ethers.utils.formatUnits(
  //             treasuryBalance
  //           )} ETH (or native token)`
  //         );
  //       }
  //     }
  //   }
  //   await bot.initialize(provider);
  //   runPromise = bot.run();
  // } catch (error: any) {
  //   // we are here if we couldn't create a liquidator (typically an RPC issue)
  //   if (error?.reason) {
  //     console.log(`error creating liquidator: ${error?.reason}`);
  //   }
  //   console.error(error);
  //   // exit to restart
  //   process.exit(1);
  // }
  // runPromise;
}

run();
