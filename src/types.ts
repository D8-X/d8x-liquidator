import { floatToABK64x64, MarginAccount } from "@d8x/perpetuals-sdk";

export const ZERO_POSITION = floatToABK64x64(0);

export interface PositionBundle {
  address: string;
  account: MarginAccount;
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
}
