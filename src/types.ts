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
  maxGasPriceGWei: number;
  gasLimit: number;
  priceFeedEndpoints: Array<PriceFeedEndpointsItem>;
  liquidatableBatchSize?: number;
  checkIntervalSecondsMin?: number;
  checkIntervalSecondsMax?: number;
  priceMovePctThreshold?: number;
}

export interface RedisMsg {
  block: number;
  hash: string;
  id: string;
}
export interface LiquidateMsg extends RedisMsg {
  perpetualId: number;
  symbol: string;
  traderAddr: string;
  tradeAmount: number;
  pnl: number;
  fee: number;
  newPositionSizeBC: number;
  liquidator: string;
}

export interface UpdateMarginAccountMsg extends RedisMsg {
  perpetualId: number;
  symbol: string;
  traderAddr: string;
  fundingPaymentCC: number;
}

export interface UpdateMarkPriceMsg extends RedisMsg {
  perpetualId: number;
  symbol: string;
  midPremium: number;
  markPremium: number;
  spotIndexPrice: number;
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
