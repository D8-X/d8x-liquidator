import { loadListenerConfig } from "../utils";
import BlockhainListener from "./blockchainListener";

require("dotenv").config();

async function start() {
  const chainId = Number(process.env.CHAIN_ID as string);
  if (chainId == undefined) {
    throw new Error(`Environment variable CHAIN_ID not defined.`);
  }
  const listenerConfig = loadListenerConfig(Number(process.env.CHAIN_ID as string));
  const eventStreamer = new BlockhainListener(listenerConfig);
  eventStreamer.start();
}

start();
