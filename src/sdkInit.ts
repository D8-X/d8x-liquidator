import { LiquidatorTool, MarketData } from "@d8-x/d8x-node-sdk";
import { Provider } from "ethers";
import { Redis } from "ioredis";
import { loadSDKState } from "./sdkState.js";

export interface MarketDataInitResult {
  usedCache: boolean;
  providerIndex: number;
  cacheAgeMs?: number;
}

export function formatCacheAgeSuffix(result: MarketDataInitResult): string {
  if (!result.usedCache) return "";
  const age = typeof result.cacheAgeMs === "number" ? `${result.cacheAgeMs}ms` : "unknown";
  return `, age=${age}`;
}

/**
 * Initialize MarketData without RPC when a cached SDK state is available in Redis.
 * Falls back to createProxyInstance(provider) retried across the given providers.
 */
export async function initMarketDataWithCache(
  md: MarketData,
  providers: Provider[],
  redis: Redis
): Promise<MarketDataInitResult> {
  if (providers.length === 0) {
    throw new Error("no providers configured");
  }
  const cached = await loadSDKState(redis, {
    chainId: md.config.chainId,
    proxyAddr: md.config.proxyAddr,
  });
  if (cached) {
    let lastCacheErr: unknown;
    let j = Math.floor(Math.random() * providers.length);
    for (let k = 0; k < providers.length; k++, j = (j + 1) % providers.length) {
      try {
        await md.createProxyInstanceFromState(cached.state, providers[j]);
        return { usedCache: true, providerIndex: j, cacheAgeMs: cached.ageMs };
      } catch (e) {
        lastCacheErr = e;
      }
    }
    console.log(
      `${new Date(Date.now()).toISOString()}: cached SDK state unusable across all providers, falling back to full init: ${String(lastCacheErr)}`
    );
  }
  let lastErr: unknown;
  let i = Math.floor(Math.random() * providers.length);
  for (let k = 0; k < providers.length; k++, i = (i + 1) % providers.length) {
    try {
      await md.createProxyInstance(providers[i]);
      return { usedCache: false, providerIndex: i };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`all RPCs are down: ${String(lastErr)}`);
}

/**
 * Initialize each LiquidatorTool from an already-initialized MarketData.
 * perpetual static info, triangulations and contract addresses
 * are copied from the shared MarketData instance.
 */
export async function initLiquidatorsFromMarketData(
  bots: { api: LiquidatorTool }[],
  md: MarketData,
  provider: Provider
): Promise<void> {
  await Promise.all(bots.map((b) => b.api.createProxyInstance(md, provider)));
}
