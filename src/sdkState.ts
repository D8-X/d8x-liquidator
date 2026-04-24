import { D8X_SDK_VERSION, type SDKState } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";

export const SDK_STATE_TTL_SECONDS = 15 * 60;
export const SDK_STATE_REPUBLISH_SECONDS = 5 * 60;

export function sdkStateKey(chainId: number): string {
  return `sdk-state:${chainId}`;
}

interface CachedSDKState {
  sdkVersion: string;
  state: SDKState;
}

export async function publishSDKState(redis: Redis, chainId: number, state: SDKState): Promise<void> {
  const payload: CachedSDKState = { sdkVersion: D8X_SDK_VERSION, state };
  await redis.set(sdkStateKey(chainId), JSON.stringify(payload), "EX", SDK_STATE_TTL_SECONDS);
}

export async function refreshSDKStateTTL(redis: Redis, chainId: number): Promise<boolean> {
  const result = await redis.expire(sdkStateKey(chainId), SDK_STATE_TTL_SECONDS);
  return result === 1;
}

export async function loadSDKState(redis: Redis, chainId: number): Promise<SDKState | null> {
  const raw = await redis.get(sdkStateKey(chainId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedSDKState>;
    if (parsed?.sdkVersion !== D8X_SDK_VERSION || !parsed.state) {
      return null;
    }
    return parsed.state;
  } catch {
    return null;
  }
}
