import { PriceFeedEndpointsItem, floatToABK64x64 } from "@d8x/perpetuals-sdk";

export const ZERO_POSITION = floatToABK64x64(0);

export interface Position {
  address: string;
  perpetualId: number;
  positionBC: number;
  cashCC: number;
  lockedInQC: number;
  unpaidFundingCC: number;
}

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
  refreshAccountsIntervalSecondsMax: number;
  refreshAccountsIntervalSecondsMin: number;
  liquidateIntervalSecondsMax: number;
  liquidateIntervalSecondsMin: number;
  fetchPricesIntervalSecondsMin: number;
  maxGasPriceGWei: number;
  gasLimit: number;
  priceFeedEndpoints: Array<PriceFeedEndpointsItem>;
}

export interface RedisMsg {
  block: number;
  hash: string;
  id: string;
}
export interface TradeMsg extends RedisMsg {
  perpetualId: number;
  symbol: string;
  orderId: string;
  traderAddr: string;
  tradeAmount: number;
  pnl: number;
  fee: number;
  newPositionSizeBC: number;
  broker: string;
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

export interface UpdateUnitAccumulatedFundingMsg extends RedisMsg {
  perpetualId: number;
  symbol: string;
  unitAccumulatedFundingCC: number;
}

export interface LiquidateTraderMsg {
  symbol: string;
  traderAddr: string;
  // px: PriceFeedSubmission;
}

export enum BotStatus {
  Ready = "Ready",
  Busy = "Busy",
  PartialError = "PartialError",
  Error = "Error",
}
