import { PriceFeedEndpointsItem } from "@d8-x/d8x-node-sdk";

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export interface LiquidatorConfig {
  sdkConfig: string;
  bots: number;
  rewardsAddress: string;
  rpcExec: string[];
  rpcWatch: string[];
  rpcListenHttp: string[];
  rpcListenWs: string[];
  waitForBlockSeconds: number;
  healthCheckSeconds: number;
  liquidateIntervalSecondsMax: number;
  liquidateIntervalSecondsMin: number;
  fetchPricesIntervalSecondsMin: number;
  gasPriceMultiplier: number;
  gasLimit: number;
  priceFeedEndpoints: Array<PriceFeedEndpointsItem>;
  liquidatableBatchSize?: number;
  checkIntervalSecondsMin?: number;
  checkIntervalSecondsMax?: number;
  priceMovePctThreshold?: number;
  priceWatchIntervalSeconds?: number;
  switchRpcOnEachRequest?: boolean;
}

export interface RedisMsg {
  block: number;
  hash: string;
  id: string;
}
export interface PerpEmergencyMsg extends RedisMsg {
  perpetualId: number;
  symbol: string;
}

export interface LiquidateTraderMsg {
  chainId: number;
  symbol: string;
  traderAddr: string;
}

export enum BotStatus {
  Ready = "Ready",
  Busy = "Busy",
  PartialError = "PartialError",
  Error = "Error",
}
