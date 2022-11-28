import { ABK64x64ToFloat, floatToABK64x64, MarginAccount } from "@d8x/perpetuals-sdk";

export const ZERO_POSITION = floatToABK64x64(0);

export interface PositionBundle {
  promiseIdx: number,
  address: string,
  account: MarginAccount
}

export interface LiqConfig {
  RPC: string[];
}
