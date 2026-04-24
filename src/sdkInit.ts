import {
  IPerpetualManager__factory,
  LiquidatorTool,
  MarketData,
  MULTICALL_ADDRESS,
  Multicall3__factory,
} from "@d8-x/d8x-node-sdk";
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
    proxyAddr: md.getProxyAddress(),
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
  await Promise.all(bots.map((b) => b.api.createProxyInstance(md)));
  for (const { api } of bots) {
    rebindBotProvider(api, md, provider);
  }
}

// TODO: to drop this hack once the SDK's `WriteAccessHandler.createProxyInstance(marketData)` overload accepts an
// explicit provider. 
// The MarketData path currently discards any provider attached to the MarketData 
// and builds a single URL JsonRpcProvider from `md.config.nodeURL`, which kills multi URL failover on reads like `proxyContract.staticCall(...)`.
// Until that SDK change lands we rebind the bot's contract handles and signer to our multURL provider here here
function rebindBotProvider(bot: LiquidatorTool, md: MarketData, provider: Provider): void {
  const anyBot = bot as unknown as {
    provider: Provider;
    signerOrProvider: Provider;
    proxyContract: ReturnType<typeof IPerpetualManager__factory.connect>;
    multicall: ReturnType<typeof Multicall3__factory.connect>;
    signer: { connect: (p: Provider) => unknown } | null;
    config: { multicall?: string };
    nodeURL: string;
  };
  anyBot.provider = provider;
  anyBot.signerOrProvider = provider;
  anyBot.proxyContract = IPerpetualManager__factory.connect(md.getProxyAddress(), provider);
  anyBot.multicall = Multicall3__factory.connect(anyBot.config.multicall ?? MULTICALL_ADDRESS, provider);
  if (anyBot.signer) {
    anyBot.signer = anyBot.signer.connect(provider) as typeof anyBot.signer;
  }
  // Align nodeURL with the rebound provider so any SDK method that falls back
  // to `this.nodeURL` (when no rpcURL override is passed) doesn't hit the
  // stale single URL that the MarketData overload copied from md.config.
  const providerUrl = (provider as unknown as { _getConnection?: () => { url: string } })._getConnection?.().url;
  if (providerUrl) {
    anyBot.nodeURL = providerUrl;
  }

  if (!anyBot.proxyContract || !anyBot.multicall || anyBot.provider !== provider) {
    throw new Error(
      "rebindBotProvider: LiquidatorTool internal fields missing or unchanged — SDK layout likely changed, audit WriteAccessHandler"
    );
  }
}
