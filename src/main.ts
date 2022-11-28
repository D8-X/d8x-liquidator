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
  const symbol = "ETH-USD-MATIC";
  let pk: string = <string>process.env.PK;
  let RPC: string = <string>process.env.RPC;
  let refConfig = loadConfig();
  if (RPC != undefined) {
    refConfig.RPC.push(RPC);
  }

  if (pk == undefined) {
    throw new Error("private key not defined");
  }
  let myReferrer: Liquidator = new Liquidator(pk, symbol);
  try {
    await myReferrer.initialize(chooseRPC(refConfig.RPC));
    await myReferrer.runForNumBlocks(10);
  } catch (error) {
    console.log(`error in referrer: ${error}`);
  }
}

run();
