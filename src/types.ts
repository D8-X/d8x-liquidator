import { ABK64x64ToFloat, floatToABK64x64, MarginAccount } from "@d8x/perpetuals-sdk";

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

export interface LiqConfig {
  RPC: string[];
  watchDogPulseLogDir: string;
  runForMaxBlocks: number;
  watchDogMaxTimeSeconds: number;
  watchDogAlarmCoolOffSeconds: number;
}

export interface watchDogAlarm {
  isCoolOff: boolean;
  timestampSec: number;
}
