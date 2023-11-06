import { BigNumber, ethers } from "ethers";
import Liquidator from "./liquidator";
import { chooseRPC, loadAccounts, loadLiquidatorConfig, sleep } from "../utils";

require("dotenv").config();

async function run() {
  let args = process.argv.slice(2);
  if (args.length != 2) {
    throw new Error("check arguments");
  }
  // args
  const symbol = args[0];
  const idxFrom = Number(args[1]);
  // validate
  if (symbol.split("-").length != 3) {
    throw new Error(`Invalid 'symbol' argument for bot: ${symbol}. It should be of the form ETH-USD-MATIC.`);
  }
  if (idxFrom <= 0) {
    throw new Error(`Invalid wallet starting index for bot: ${idxFrom}. It should be a positive integer.`);
  }
  // env
  const chainId = process.env.CHAIN_ID ? BigNumber.from(process.env.CHAIN_ID as string) : undefined;
  const mnemonicSeed = process.env.SEED_PHRASE;
  const earningsAddr = process.env.EARNINGS_WALLET;
  const accountsPerPerp = Number(process.env.ACCOUNTS_PER_BOT ?? "1");
  const modulo = Number(process.env.PEER_COUNT as string);
  const residual = Number(process.env.PEER_INDEX as string);
  // validate
  if (!chainId) {
    throw new Error("Please enter a chain ID in .env file, e.g. export CHAIN_ID=42");
  }
  if (mnemonicSeed === undefined) {
    throw new Error("Please enter a mnemonic seed in .env file, e.g. export SEED_PHRASE='your seed phrase'");
  }
  if (earningsAddr === undefined) {
    throw new Error(
      "Please enter an address to collect earnings in .env file, e.g. export EARNINGS_WALLET='0xYourAddress'"
    );
  }
  if (accountsPerPerp === undefined || accountsPerPerp <= 0) {
    throw new Error("Please enter a valid number of wallets per bot in .env file, e.g. export ACCOUNTS_PER_BOT=5");
  }
  if (modulo == undefined || modulo < 1 || residual == undefined || residual < 0 || residual >= modulo) {
    throw new Error(`Invalid peer index/count pair ${residual}/${modulo}`);
  }
  // bot treasury
  const {
    addr: [treasuryAddr],
    pk: [treasuryPK],
  } = loadAccounts(mnemonicSeed, 0, 0);
  // bot wallets
  const { addr, pk } = loadAccounts(mnemonicSeed, idxFrom, idxFrom + accountsPerPerp - 1);
  // load config
  const config = loadLiquidatorConfig(chainId);
  // check that price services are up
  for (const pxServices of config.priceFeedEndpoints) {
    let someOk = false;
    for (const endpoint of pxServices.endpoints) {
      const response = await fetch(endpoint.replace("/api", "/live"));
      someOk = someOk || response.ok;
    }
    if (!someOk) {
      const coolDown = 60_000 + Math.floor(Math.random() * 60_000);
      console.log(
        `${pxServices.type} price service is down. Reconnecting in ${Math.round((10 * coolDown) / 60_000) / 10} minutes`
      );
      await sleep(coolDown);
      process.exit(1);
    }
  }
  console.log(`\nStarting ${addr.length} ${symbol} bots with addresses:`);
  for (let refAddr of addr) {
    console.log(refAddr);
  }

  let lastRPC = "";
  let bot: Liquidator;
  let runPromise: Promise<void>;
  try {
    bot = new Liquidator(pk, symbol, config, modulo, residual, earningsAddr);
    let currRPC = chooseRPC(config.RPC, lastRPC);
    lastRPC = currRPC;
    const provider = new ethers.providers.StaticJsonRpcProvider(currRPC);
    const treasury = new ethers.Wallet(treasuryPK, provider);
    // min balance should cover 1e7 gas
    const minBalance = ethers.utils.parseUnits(`${config.maxGasPriceGWei * 1e7}`, "gwei");
    for (let relayerAddr of addr) {
      const relayerBalance = await provider.getBalance(relayerAddr);
      console.log(
        `Relayer (${relayerAddr}) balance: ${ethers.utils.formatUnits(relayerBalance)} ETH (or native token)`
      );
      const treasuryBalance = await provider.getBalance(treasuryAddr);
      console.log(
        `Treasury (${treasuryAddr}) balance: ${ethers.utils.formatUnits(treasuryBalance)} ETH (or native token)`
      );
      console.log(`Minimum balance: ${ethers.utils.formatUnits(minBalance)} ETH (or native token)`);
      if (relayerBalance.lt(minBalance)) {
        // transfer twice the min so it doesn't transfer every time
        const transferAmount = minBalance.mul(2).sub(relayerBalance);
        if (transferAmount.lt(treasuryBalance)) {
          console.log(`Funding relayer with ${ethers.utils.formatUnits(transferAmount)} tokens...`);
          const tx = await treasury.sendTransaction({
            to: relayerAddr,
            value: transferAmount,
          });
          console.log(`Transferring tokens - tx hash: ${tx.hash}`);
          await tx.wait();
          console.log(
            `Successfully transferred ${ethers.utils.formatUnits(
              transferAmount
            )} ETH (or native token) from treasury to relayer ${relayerAddr}`
          );
        } else {
          // TODO: notify a human
          throw new Error(
            `CRITICAL: insufficient balance in treasury ${ethers.utils.formatUnits(
              treasuryBalance
            )} ETH (or native token)`
          );
        }
      }
    }
    await bot.initialize(provider);
    runPromise = bot.run();
  } catch (error: any) {
    // we are here if we couldn't create a liquidator (typically an RPC issue)
    if (error?.reason) {
      console.log(`error creating liquidator: ${error?.reason}`);
    }
    console.error(error);
    // exit to restart
    process.exit(1);
  }
  runPromise;
}

run();
