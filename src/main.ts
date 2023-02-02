import { ethers } from "ethers";
import Liquidator from "./liquidator";
import { loadConfig } from "./types";

function chooseRPC(rpcArray: string[]): string {
  let idx = Math.floor(Math.random() * rpcArray.length);
  return rpcArray[idx];
}

function getPrivateKeyFromSeed(mnemonic: string, idx: number) {
  if (mnemonic == undefined) {
    throw Error("mnemonic seed phrase needed: export mnemonic='...");
  }
  const baseDerivationPath = "m/44'/60'/0'/0";
  const path = `${baseDerivationPath}/${idx}`;
  const mnemonicWallet = ethers.Wallet.fromMnemonic(mnemonic, path);
  return [mnemonicWallet.address, mnemonicWallet.privateKey];
}

async function run() {
  let args = process.argv.slice(2);
  if (args.length != 2) {
    throw new Error("symbol-argument and private key index needed, e.g. ETH-USD-MATIC 0");
  }
  const idx = Number(args[1]);
  const mnemonicSeed: string = <string>process.env.MNEMONIC;
  let [addr, pk] = getPrivateKeyFromSeed(mnemonicSeed, idx);
  const symbol = args[0];

  console.log(`Running ${symbol} for liquidator address ${addr}`);
  // add RPCs: RPC, RPC1, RPC2,..
  let liqConfig = loadConfig();
  let RPC: string = <string>process.env["RPC"];
  let k = 1;
  while (RPC != undefined) {
    console.log(`adding RPC: ${RPC}`);
    liqConfig.RPC.push(RPC);
    RPC = <string>process.env["RPC" + k];
    k++;
  }

  if (pk == undefined) {
    throw new Error("Private key not defined");
  }
  console.log(`Starting liquidator for symbol ${symbol}...`);
  let myLiquidator: Liquidator = new Liquidator(pk, symbol, liqConfig);
  try {
    let rpc = chooseRPC(liqConfig.RPC);
    console.log(`Initializing liquidator using RPC ${rpc}...`);
    await myLiquidator.initialize(rpc);
    console.log(`Liquidator initialized. Running for ${liqConfig.runForMaxBlocks} blocks ...`);
    await myLiquidator.runForNumBlocks(liqConfig.runForMaxBlocks);
  } catch (e) {
    console.log(e);
  }
}

run();
