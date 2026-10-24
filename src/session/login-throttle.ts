/** Failed sign-ins allowed per username and address within the window before a lockout. */
export const MAX_FAILURES = 5;
/**
 * The same, per username across every address. Much higher, so a guesser spread over many
 * addresses is still stopped without a few failures from elsewhere locking the owner out.
 */
export const MAX_FAILURES_PER_USERNAME = 30;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Entries kept at once; the least recently used go first. */
export const MAX_ENTRIES = 10_000;

type Entry = { failures: number[]; lockedUntil: number; limit: number };

/**
 * Slows password guessing, per username and address and per username alone.
 *
 * An attempt is reserved *before* the password check (`reserve`) and counts as a failure until
 * `recordSuccess` takes it back, so attempts that are still inside the slow password hash count
 * toward the limit: a burst of parallel guesses cannot all slip past a counter that is only
 * updated afterwards.
 *
 * Keyed by username *and* address, so an attacker cannot lock a real owner out from elsewhere by
 * failing on purpose, and in-process like the key-reveal limiter: one container serves an
 * install, and a guesser who restarts it to reset the counter has bigger access already. The map
 * is bounded (least recently used first) and expired entries are dropped as it is used, so a
 * spray of random usernames cannot grow it without limit.
 */
export class LoginThrottle {
  /** Insertion order is least-recently-used first: an entry is re-inserted whenever it is used. */
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxEntries: number = MAX_ENTRIES,
  ) {}

  /** Number of entries held, for tests. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Milliseconds until this may try again, or 0 when it may: in which case the attempt is
   * reserved. Reserve only once per attempt, before checking the password.
   */
  reserve(username: string, ip: string | null): number {
    const now = this.now();
    this.prune(now);
    const keys = [pairKey(username, ip), userKey(username)];
    const wait = Math.max(
      ...keys.map((k) => Math.max(0, (this.entries.get(k)?.lockedUntil ?? 0) - now)),
    );
    if (wait > 0) return wait;
    this.add(keys[0] as string, MAX_FAILURES, now);
    this.add(keys[1] as string, MAX_FAILURES_PER_USERNAME, now);
    return 0;
  }

  /** The password was right: forget this pair's failures and give back the reserved attempt. */
  recordSuccess(username: string, ip: string | null): void {
    this.entries.delete(pairKey(username, ip));
    const user = this.entries.get(userKey(username));
    if (user) user.failures.pop();
  }

  private add(k: string, limit: number, now: number): void {
    const entry = this.entries.get(k) ?? { failures: [], lockedUntil: 0, limit };
    entry.failures = [...entry.failures.filter((at) => now - at < WINDOW_MS), now];
    if (entry.failures.length >= limit) {
      entry.lockedUntil = now + LOCKOUT_MS;
      entry.failures = [];
    }
    this.entries.delete(k);
    this.entries.set(k, entry);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /** Drops entries with nothing left to remember, oldest first, until one still matters. */
  private prune(now: number): void {
    for (const [k, entry] of this.entries) {
      const live = entry.lockedUntil > now || entry.failures.some((at) => now - at < WINDOW_MS);
      if (live) return;
      this.entries.delete(k);
    }
  }
}

function pairKey(username: string, ip: string | null): string {
  return `${normalise(username)}|${ip ?? "-"}`;
}

function userKey(username: string): string {
  return `${normalise(username)}|*`;
}

function normalise(username: string): string {
  return username.trim().toLowerCase();
}
