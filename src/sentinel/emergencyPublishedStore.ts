export const EMERGENCY_DEDUPE_MS = 10 * 60 * 1000;

export class EmergencyPublishedStore {
  private lastPublished = new Map<number, number>();

  shouldIgnore(perpId: number): boolean {
    const last = this.lastPublished.get(perpId);
    return last !== undefined && Date.now() - last < EMERGENCY_DEDUPE_MS;
  }

  markPublished(perpId: number): void {
    this.lastPublished.set(perpId, Date.now());
  }
}
