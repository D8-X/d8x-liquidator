import { ethers } from "ethers";
import Liquidator from "./liquidator";
import { chooseRPC, loadAccounts, loadLiquidatorConfig } from "../utils";

require("dotenv").config();

async function run() {
  let args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    throw new Error("check arguments");
  }

  // E.g. MATIC-USD-MATIC
  const symbol = args[0];
  if (symbol.split("-").length != 3) {
    throw new Error(`Invalid 'symbol' argument: ${symbol}. It should be of the form ETH-USD-MATIC.`);
  }
  // First wallet to extract from mnemonic seed, 0-indexed
  const idxFrom = Number(args[1]);
  if (idxFrom < 0) {
    throw new Error(`Invalid 'from' argument: ${idxFrom}.`);
  }

  // Last wallet to extrat from mnemonic seed:
  // defaults to first one if not specified (i.e. single wallet)
  let idxTo: number;
  if (args.length > 2) {
    idxTo = Number(args[2]);
    if (idxTo == undefined || isNaN(idxTo) || idxTo < idxFrom) {
      throw new Error(`Invalid 'to' argument: ${idxTo}.`);
    }
  } else {
    idxTo = idxFrom;
  }
  const chainId = process.env.CHAIN_ID ? Number(process.env.CHAIN_ID as string) : undefined;
  if (!chainId) {
    throw new Error("Chain ID missing in env file.");
  }

  const mnemonicSeed: string = <string>process.env.SEED_PHRASE;
  const treasuryIdx = Number(process.env.TREASURY_INDEX as string);
  if (treasuryIdx == undefined) {
    throw new Error("treasury index not defined");
  }
  const {
    addr: [treasuryAddr],
    pk: [treasuryPK],
  } = loadAccounts(mnemonicSeed, treasuryIdx, treasuryIdx);

  const { addr, pk } = loadAccounts(mnemonicSeed, idxFrom, idxTo);

  const modulo = Number(process.env.PEER_COUNT as string);
  const residual = Number(process.env.PEER_INDEX as string);
  if (modulo == undefined || modulo < 1 || residual == undefined || residual < 0 || residual >= modulo) {
    throw new Error(`Invalid peer index/count pair ${residual}/${modulo}`);
  }

  const config = loadLiquidatorConfig(chainId);

  console.log(`\nStarting ${addr.length} ${symbol} bots with addresses:`);
  for (let refAddr of addr) {
    console.log(refAddr);
  }

  let lastRPC = "";
  let bot: Liquidator;
  let runPromise: Promise<void>;
  try {
    bot = new Liquidator(pk, symbol, config, modulo, residual, treasuryAddr);
    let currRPC = chooseRPC(config.RPC, lastRPC);
    lastRPC = currRPC;
    const provider = new ethers.providers.StaticJsonRpcProvider(currRPC);
    const treasury = new ethers.Wallet(treasuryPK, provider);
    // min balance should cover 1e7 gas
    const minBalance = ethers.utils.parseUnits(`${config.maxGasPriceGWei * 1e7}`, "gwei"); //ethers.BigNumber.from(Math.round(refConfig.maxGasPriceGWei * 1e16)); // 1e9: to wei, 1e7: 10 million
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
