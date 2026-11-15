// "N photos per phone per hour", counted in memory (a restart forgets, which is fine).
//
// A phone is its device id (a random id the page keeps in localStorage) and its address. The
// device id alone could be reset by clearing the browser, so each address also gets a looser
// cap (a few phones can share an address: a household, or one public IP standalone).

const HOUR = 60 * 60 * 1000;
/** How many phones' worth one address may send. */
export const PER_ADDRESS_FACTOR = 4;

export class HourlyLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly now: () => number = Date.now) {}

  private recent(key: string): number[] {
    const cutoff = this.now() - HOUR;
    const list = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** How many more the keys may send, and when the next one frees up (ms from now). */
  check(device: string, address: string, perHour: number): { allowed: boolean; retryInMs: number } {
    const d = this.recent(`d:${device}`);
    const a = this.recent(`a:${address}`);
    const blockedBy = d.length >= perHour ? d : a.length >= perHour * PER_ADDRESS_FACTOR ? a : null;
    if (!blockedBy) return { allowed: true, retryInMs: 0 };
    const oldest = blockedBy[blockedBy.length - Math.min(blockedBy.length, blockedBy === d ? perHour : perHour * PER_ADDRESS_FACTOR)];
    return { allowed: false, retryInMs: Math.max(0, oldest + HOUR - this.now()) };
  }

  record(device: string, address: string): void {
    const t = this.now();
    for (const key of [`d:${device}`, `a:${address}`]) this.hits.set(key, [...this.recent(key), t]);
  }

  /** Drops keys with nothing in the last hour. */
  prune(): void {
    for (const key of [...this.hits.keys()]) this.recent(key);
  }

  clear(): void {
    this.hits.clear();
  }
}
