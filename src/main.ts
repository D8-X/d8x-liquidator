import Liquidator from "./liquidator";
import { LiqConfig } from "./types";

function loadConfig(): LiqConfig {
  let file = require("./liquidatorConfig.json");
  let config: LiqConfig = { RPC: file["RPC"] };
  return config;
}

function chooseRPC(rpcArray: string[]): string {
  let idx = Math.floor(Math.random() * rpcArray.length);
  return rpcArray[idx];
}

async function run() {
  const symbol = process.argv[2] ?? "MATIC-USD-MATIC"; // "ETH-USD-MATIC";
  let pk: string = <string>process.env.PK;
  let RPC: string = <string>process.env.RPC;
  let liqConfig = loadConfig();
  if (RPC != undefined) {
    liqConfig.RPC.push(RPC);
  }

  if (pk == undefined) {
    throw new Error("Private key not defined: use $export PK='myPrivateKey'");
  }
  console.log(`Starting liquidator for symbol ${symbol}...`);
  let myLiquidator: Liquidator = new Liquidator(pk, symbol);
  try {
    await myLiquidator.initialize(chooseRPC(liqConfig.RPC));
    await myLiquidator.runForNumBlocks(10);
  } catch (e) {
    console.log(e);
  }
}

run();
