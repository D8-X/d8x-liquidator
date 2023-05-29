import { Redis } from "ioredis";
import { RedisConfig, LiqConfig } from "./types";
import { ethers } from "ethers";

require("dotenv").config();

export function loadConfig(otherRPC?: string | undefined, onlyOther?: string | undefined): LiqConfig {
  let file = require("./referrerConfig.json");
  let config: LiqConfig = {
    RPC: file["RPC"],
    watchDogPulseLogDir: file["watchDogPulseLogDir"],
    runForMaxBlocks: file["runForMaxBlocks"],
    watchDogMaxTimeSeconds: file["watchDogMaxTimeSeconds"],
    watchDogAlarmCoolOffSeconds: file["watchDogAlarmCoolOffSeconds"],
  };

  if (onlyOther != undefined && onlyOther.toLowerCase() == "true") {
    config.RPC = [];
  }
  let k = 1;
  while (otherRPC != undefined) {
    console.log(`adding RPC: ${otherRPC}`);
    config.RPC.push(otherRPC);
    otherRPC = <string>process.env["RPC_HTTP_URL" + k];
    k++;
  }
  if (config.RPC == undefined || config.RPC.length < 1) {
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
