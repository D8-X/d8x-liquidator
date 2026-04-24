import type { SDKState } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";

export function sdkStateKey(chainId: number): string {
  return `sdk-state:${chainId}`;
}

export async function publishSDKState(redis: Redis, chainId: number, state: SDKState): Promise<void> {
  await redis.set(sdkStateKey(chainId), JSON.stringify(state));
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
