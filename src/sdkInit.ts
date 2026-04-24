import { LiquidatorTool, MarketData } from "@d8-x/d8x-node-sdk";
import { Provider } from "ethers";
import { Redis } from "ioredis";
import { loadSDKState } from "./sdkState.js";

export interface MarketDataInitResult {
  usedCache: boolean;
  providerIndex: number;
}

/**
 * Initialize MarketData without RPC when a cached SDK state is available in Redis.
 * Falls back to createProxyInstance(provider) retried across the given providers.
 */
export async function initMarketDataWithCache(
  md: MarketData,
  providers: Provider[],
  redis: Redis,
  chainId: number
): Promise<MarketDataInitResult> {
  const state = await loadSDKState(redis, chainId);
  if (state) {
    await md.createProxyInstanceFromState(state, providers[0]);
    return { usedCache: true, providerIndex: 0 };
  }
  let lastErr: unknown;
  for (let i = 0; i < providers.length; i++) {
    try {
      await md.createProxyInstance(providers[i]);
      return { usedCache: false, providerIndex: i };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(`all RPCs are down: ${lastErr}`);
}

/**
 * Initialize each LiquidatorTool from an already-initialized MarketData.
 * perpetual static info, triangulations and contract addresses
 * are copied from the shared MarketData instance.
 */
export async function initLiquidatorsFromMarketData(
  bots: { api: LiquidatorTool }[],
  md: MarketData
): Promise<void> {
  await Promise.all(bots.map((b) => b.api.createProxyInstance(md)));
}
