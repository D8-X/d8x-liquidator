import { ethers } from "ethers";
import Liquidator from "./liquidator";
import { chooseRPC, loadAccounts, loadConfig } from "../utils";

require("dotenv").config();

// Args: symbol (e.g. ETH-USD-MATIC) and pk index along derivation path (e.g. 1)
async function run() {
  let args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    throw new Error("check arguments");
  }

  // E.g. MATIC-USD-MATIC
  const symbol = args[0];
  if (symbol.split("-").length != 3) {
    throw new Error(`Invalyd 'symbol' argument: ${symbol}. It should be of the form ETH-USD-MATIC.`);
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
  // load pk's of liquidators
  const mnemonicSeed: string = <string>process.env.SEED_PHRASE;
  const { addr, pk } = loadAccounts(mnemonicSeed, idxFrom, idxTo);

  let httpRPC = <string>process.env.RPC_HTTP_URL;
  let onlyOwnRPC = <string>process.env.RPC_USE_OWN_ONLY;
  let config = loadConfig(httpRPC, onlyOwnRPC);

  // start liquidating
  console.log(`Starting ${addr.length} liquidators for symbol ${symbol} using addresses`, addr);
  let liquidator: Liquidator;
  let lastRPC = "";
  let runPromise: Promise<void>;
  try {
    liquidator = new Liquidator(pk, symbol, config);
    let currRPC = chooseRPC(config.RPC, lastRPC);
    console.log(`using RPC:\n${currRPC}`);
    lastRPC = currRPC;
    const provider = new ethers.providers.StaticJsonRpcProvider(currRPC);
    await liquidator.initialize(provider);
    console.log(`Liquidator initialized. Running for ${config.runForMaxBlocks} blocks ...`);
    runPromise = liquidator.runForNumBlocks(config.runForMaxBlocks);
  } catch (e: any) {
    // we are here if we couldn't create a referrer (typically an RPC issue)
    if (e?.reason) {
      console.log(`error creating liquidator: ${e?.reason}`);
    } else {
      console.log(e);
    }
    // exit to restart
    process.exit(1);
  }

  // main run
  try {
    console.log(`\nRunning for ${config.runForMaxBlocks} blocks`);
    await runPromise;
  } catch (error) {
    console.log("error running liquidator:\n");
    console.log(error);
  } finally {
    process.exit(1);
  }
}

run();
