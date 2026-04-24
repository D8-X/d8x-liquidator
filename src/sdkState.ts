import type { SDKState } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";

export const SDK_STATE_TTL_SECONDS = 15 * 60;
export const SDK_STATE_REPUBLISH_SECONDS = 5 * 60;

export function sdkStateKey(chainId: number): string {
  return `sdk-state:${chainId}`;
}

export async function publishSDKState(redis: Redis, chainId: number, state: SDKState): Promise<void> {
  await redis.set(sdkStateKey(chainId), JSON.stringify(state), "EX", SDK_STATE_TTL_SECONDS);
}

export async function loadSDKState(redis: Redis, chainId: number): Promise<SDKState | null> {
  const raw = await redis.get(sdkStateKey(chainId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SDKState;
  } catch {
    return null;
  }
}
