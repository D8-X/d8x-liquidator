import { Redis } from "ioredis";

export const EMERGENCY_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const EMERGENCY_SWEEP_INTERVAL_MS = 60 * 60 * 1000;

export class EmergencyPublishedStore {
  private map = new Map<number, { stamp: symbol; addedAt: number }>();

  constructor(private readonly redis: Redis, private readonly chainId: bigint) {}

  private key(): string {
    return `liquidator:sentinel:emergencyPublished:${this.chainId.toString()}`;
  }

  has(perpId: number): boolean {
    return this.map.has(perpId);
  }

  isOwned(perpId: number, stamp: symbol): boolean {
    return this.map.get(perpId)?.stamp === stamp;
  }

  add(perpId: number): symbol {
    const stamp = Symbol();
    const addedAt = Date.now();
    this.map.set(perpId, { stamp, addedAt });
    this.redis.hset(this.key(), perpId.toString(), addedAt.toString()).catch((e) => {
      console.log({
        event: "emergencyHsetFailed",
        level: "warn",
        time: new Date().toISOString(),
        perpetualId: perpId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
    return stamp;
  }

  delete(perpId: number): void {
    if (!this.map.has(perpId)) return;
    this.map.delete(perpId);
    this.redis.hdel(this.key(), perpId.toString()).catch((e) => {
      console.log({
        event: "emergencyHdelFailed",
        level: "warn",
        time: new Date().toISOString(),
        perpetualId: perpId,
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  async hydrate(): Promise<void> {
    try {
      const raw = await this.redis.hgetall(this.key());
      const now = Date.now();
      for (const [perpIdStr, addedAtStr] of Object.entries(raw)) {
        const perpId = Number(perpIdStr);
        const addedAt = Number(addedAtStr);
        if (!Number.isFinite(perpId) || !Number.isFinite(addedAt) || addedAt <= 0) {
          this.redis.hdel(this.key(), perpIdStr).catch(() => {});
          continue;
        }
        if (now - addedAt > EMERGENCY_TTL_MS) {
          this.redis.hdel(this.key(), perpIdStr).catch(() => {});
          continue;
        }
        this.map.set(perpId, { stamp: Symbol(), addedAt });
      }
    } catch (e) {
      console.log({
        event: "hydrateEmergencyPublishedFailed",
        level: "warn",
        time: new Date().toISOString(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  sweep(): void {
    const now = Date.now();
    for (const [perpId, entry] of this.map) {
      if (now - entry.addedAt > EMERGENCY_TTL_MS) {
        this.delete(perpId);
      }
    }
  }

  startSweepTimer(): void {
    setInterval(() => this.sweep(), EMERGENCY_SWEEP_INTERVAL_MS);
  }
}
