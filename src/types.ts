import { ABK64x64ToFloat, floatToABK64x64, MarginAccount } from "@d8x/perpetuals-sdk";

export const ZERO_POSITION = floatToABK64x64(0);

export interface PositionBundle {
  address: string;
  account: MarginAccount;
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

export function loadConfig(): LiqConfig {
  let file = require("./liquidatorConfig.json");
  let config: LiqConfig = {
    RPC: file["RPC"],
    watchDogPulseLogDir: file["watchDogPulseLogDir"],
    runForMaxBlocks: file["runForMaxBlocks"],
    watchDogMaxTimeSeconds: file["watchDogMaxTimeSeconds"],
    watchDogAlarmCoolOffSeconds: file["watchDogAlarmCoolOffSeconds"],
  };
  return config;
}
