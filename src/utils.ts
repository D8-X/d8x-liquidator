import { Redis } from "ioredis";
import { RedisConfig, ListenerConfig, LiquidatorConfig } from "./types";
import { BigNumber, BigNumberish, ethers } from "ethers";

require("dotenv").config();

export function loadLiquidatorConfig(chainId: BigNumberish): LiquidatorConfig {
  const configList = require("./config/live.liquidatorConfig.json") as LiquidatorConfig[];
  const config = configList.find((config) => BigNumber.from(config.chainId).eq(BigNumber.from(chainId)));
  if (!config) {
    throw new Error(`Chain ID ${chainId} not found in config file.`);
  }
  return config;
}

export function loadListenerConfig(chainId: number): ListenerConfig {
  const configList = require("./config/live.listenerConfig.json") as ListenerConfig[];
  let config = configList.find((config) => config.chainId == chainId);
  if (!config) {
    throw new Error(`Chain ID ${chainId} not found in config file.`);
  }
  if (config.httpRPC.length < 1) {
    throw new Error("no RPC defined");
  }
  return config;
}

export function loadAccounts(mnemonicSeed: string, idxFrom: number, idxTo: number) {
  let addr: string[] = [];
  let pk: string[] = [];
  for (let myIdx = idxFrom; myIdx <= idxTo; myIdx++) {
    let [myAddr, myPK] = getPrivateKeyFromSeed(mnemonicSeed, myIdx);
    addr.push(myAddr);
    pk.push(myPK);
  }
  if (pk.length < 1) {
    throw new Error("private key not defined");
  }
  return { addr: addr, pk: pk };
}

export function chooseRPC(rpcArray: string[], lastRPC?: string): string {
  if (lastRPC == undefined) {
    lastRPC = "";
  }
  let currRPC;
  do {
    let idx = Math.floor(Math.random() * rpcArray.length);
    currRPC = rpcArray[idx];
  } while (currRPC == lastRPC && rpcArray.length > 1);
  console.log({ RPC: currRPC });
  return currRPC;
}

export function getPrivateKeyFromSeed(mnemonic: string, idx: number) {
  if (mnemonic == undefined) {
    throw Error("mnemonic seed phrase needed: export mnemonic='...");
  }
  const baseDerivationPath = "m/44'/60'/0'/0";
  const path = `${baseDerivationPath}/${idx}`;
  const mnemonicWallet = ethers.Wallet.fromMnemonic(mnemonic, path);
  return [mnemonicWallet.address, mnemonicWallet.privateKey];
}

export function getRedisConfig(): RedisConfig {
  let originUrl = process.env.REDIS_URL;
  if (originUrl == undefined) {
    throw new Error("REDIS_URL not defined");
  }
  console.log("URL=", originUrl);
  let redisURL = new URL(originUrl);
  const host = redisURL.hostname;
  const port = parseInt(redisURL.port);
  const redisPassword = redisURL.password;
  let config = { host: host, port: port, password: redisPassword! };

  return config;
}

export function constructRedis(name: string): Redis {
  let client;
  let redisConfig = getRedisConfig();
  //console.log(redisConfig);
  console.log(`${name} connecting to redis: ${redisConfig.host}`);
  client = new Redis(redisConfig);
  client.on("error", (err) => console.log(`${name} Redis Client Error:` + err));
  return client;
}

/**
 *
 * @param promise async function to be esxecuted
 * @param timeoutMs timeout in MS
 * @param errMsgOnTimeout optional error message
 * @returns function return value or ends in error
 */
export function executeWithTimeout<T>(
  promise: Promise<T>,
  timeout: number,
  errMsgOnTimeout: string | undefined = undefined
): Promise<T> {
  let timeoutId: NodeJS.Timeout;

  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => {
      const msg = errMsgOnTimeout ?? "Function execution timed out.";
      reject(new Error(msg));
    }, timeout);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
