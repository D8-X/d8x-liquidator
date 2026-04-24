import { D8X_SDK_VERSION, type SDKState } from "@d8-x/d8x-node-sdk";
import { Redis } from "ioredis";

export const SDK_STATE_TTL_SECONDS = 15 * 60;
export const SDK_STATE_REPUBLISH_SECONDS = 5 * 60;

export function sdkStateKey(chainId: number): string {
  return `sdk-state:${chainId}`;
}

interface CachedSDKState {
  sdkVersion: string;
  publishedAt: number; 
  state: SDKState;
}

export interface LoadedSDKState {
  state: SDKState;
  ageMs: number;
}

export async function publishSDKState(redis: Redis, chainId: number, state: SDKState): Promise<void> {
  const payload: CachedSDKState = { sdkVersion: D8X_SDK_VERSION, publishedAt: Date.now(), state };
  await redis.set(sdkStateKey(chainId), JSON.stringify(payload), "EX", SDK_STATE_TTL_SECONDS);
}

export async function refreshSDKStateTTL(redis: Redis, chainId: number): Promise<boolean> {
  const result = await redis.expire(sdkStateKey(chainId), SDK_STATE_TTL_SECONDS);
  return result === 1;
}

export interface TrustedAnchors {
  chainId: number;
  proxyAddr: string;
}

export async function loadSDKState(redis: Redis, anchors: TrustedAnchors): Promise<LoadedSDKState | null> {
  const raw = await redis.get(sdkStateKey(anchors.chainId));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CachedSDKState>;
    if (parsed?.sdkVersion !== D8X_SDK_VERSION || !parsed.state) {
      return null;
    }
    if (parsed.state.chainId !== anchors.chainId) return null;
    if (
      typeof parsed.state.proxyAddr !== "string" ||
      parsed.state.proxyAddr.toLowerCase() !== anchors.proxyAddr.toLowerCase()
    ) {
      return null;
    }
    const ageMs = typeof parsed.publishedAt === "number" ? Date.now() - parsed.publishedAt : NaN;
    return { state: parsed.state, ageMs };
  } catch {
    return null;
  }
}
