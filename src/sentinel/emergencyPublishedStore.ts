export const EMERGENCY_DEDUPE_MS = 10 * 60 * 1000;

export class EmergencyPublishedStore {
  private lastPublished = new Map<number, number>();

  shouldIgnore(perpId: number): boolean {
    const last = this.lastPublished.get(perpId);
    return last !== undefined && Date.now() - last < EMERGENCY_DEDUPE_MS;
  }

  markPublished(perpId: number): void {
    const now = Date.now();
    for (const [id, ts] of this.lastPublished) {
      if (now - ts >= EMERGENCY_DEDUPE_MS) this.lastPublished.delete(id);
    }
    this.lastPublished.set(perpId, now);
  }

  clear(perpId: number): void {
    this.lastPublished.delete(perpId);
  }
}
