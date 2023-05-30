import { PerpetualDataHandler } from "@d8x/perpetuals-sdk";
import { chooseRPC, loadConfig } from "../utils";
import BlockhainListener from "./blockchainListener";
import { ethers } from "ethers";

require("dotenv").config();

async function start() {
  // HTTP RPC chosen from list + environment
  const refConfig = loadConfig(process.env.RPC_HTTP_URL, process.env.RPC_USE_OWN_ONLY);
  const httpRPC = chooseRPC(refConfig.RPC);
  const httpProvider = new ethers.providers.StaticJsonRpcProvider(httpRPC);
  // WS RPC from environment
  const wsProvider = new ethers.providers.WebSocketProvider(process.env.RPC_WS_URL!);

  await httpProvider.ready;
  await wsProvider.ready;

  const eventStreamer = new BlockhainListener(httpProvider, wsProvider);

  // start listening
  eventStreamer.listen();

  // check heartbeat every N minutes - if WS block number is behind latest block from HTTP call, restart
  setInterval(async () => {
    const latestBlock = await httpProvider.getBlockNumber();
    eventStreamer.checkHeartbeat(latestBlock);
  }, 15 * 60 * 1_000);
}

start();
