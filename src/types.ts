import { floatToABK64x64, MarginAccount } from "@d8x/perpetuals-sdk";

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
  password: string;
}

export interface LiquidatorConfig {
  chainId: number;
  RPC: string[];
  gasStation: string;
  liquidateIntervalSeconds: number;
  refreshAccountsSeconds: number;
  maxGasPriceGWei: number;
  priceFeedEndpoints: Array<{ type: string; endpoints: string[] }>;
}

export interface ListenerConfig {
  chainId: number;
  sdkConfig: string;
  httpRPC: string[];
  wsRPC: string[];
  waitForBlockseconds: number;
  healthCheckSeconds: number;
  maxRefreshAccountIntervalSeconds: number;
  minRefreshAccountIntervalSeconds: number;
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
  positionBC: number;
  cashCC: number;
  lockedInQC: number;
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
