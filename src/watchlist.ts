import { Redis } from "ioredis";

export const WATCHLIST_TTL_SECONDS = 30 * 60;

export type PerpStates = Record<string, string>;

export function watchlistKey(chainId: number): string {
  return `liquidator-watchlist:${chainId}`;
}

export function watchlistChannel(chainId: number): string {
  return `liquidator-watchlist-updates:${chainId}`;
}

export function serializePerpStates(states: PerpStates): string {
  const sortedKeys = Object.keys(states).sort();
  const ordered: PerpStates = {};
  for (const k of sortedKeys) ordered[k] = states[k];
  return JSON.stringify(ordered);
}

export async function publishWatchlist(redis: Redis, chainId: number, payload: string): Promise<void> {
  await redis.set(watchlistKey(chainId), payload, "EX", WATCHLIST_TTL_SECONDS);
  await redis.publish(watchlistChannel(chainId), payload);
}

export async function loadWatchlist(redis: Redis, chainId: number): Promise<PerpStates | null> {
  const raw = await redis.get(watchlistKey(chainId));
  if (!raw) return null;
  return parsePerpStates(raw);
}

export function parsePerpStates(raw: string): PerpStates | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const out: PerpStates = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return null;
  }
}
