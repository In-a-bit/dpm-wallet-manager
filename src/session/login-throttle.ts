/** Failed sign-ins allowed per username and address within the window before a lockout. */
export const MAX_FAILURES = 5;
export const WINDOW_MS = 15 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;

type Entry = { failures: number[]; lockedUntil: number };

/**
 * Slows password guessing against one account from one address.
 *
 * Keyed by username *and* address, so an attacker cannot lock a real owner out from elsewhere by
 * failing on purpose, and in-process like the key-reveal limiter: one container serves an
 * install, and a guesser who restarts it to reset the counter has bigger access already.
 */
export class LoginThrottle {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds until the pair may try again, or 0 when it may try now. */
  retryAfterMs(username: string, ip: string | null): number {
    const entry = this.entries.get(key(username, ip));
    return entry ? Math.max(0, entry.lockedUntil - this.now()) : 0;
  }

  recordFailure(username: string, ip: string | null): void {
    const now = this.now();
    const k = key(username, ip);
    const entry = this.entries.get(k) ?? { failures: [], lockedUntil: 0 };
    entry.failures = [...entry.failures.filter((at) => now - at < WINDOW_MS), now];
    if (entry.failures.length >= MAX_FAILURES) {
      entry.lockedUntil = now + LOCKOUT_MS;
      entry.failures = [];
    }
    this.entries.set(k, entry);
  }

  recordSuccess(username: string, ip: string | null): void {
    this.entries.delete(key(username, ip));
  }
}

function key(username: string, ip: string | null): string {
  return `${username.trim().toLowerCase()}|${ip ?? "-"}`;
}
