import {
  LOCKOUT_MS,
  LoginThrottle,
  MAX_FAILURES,
  MAX_FAILURES_PER_USERNAME,
  WINDOW_MS,
} from "./login-throttle";

describe("LoginThrottle", () => {
  let now = 0;
  const throttle = (max?: number) => new LoginThrottle(() => now, max);
  /** Attempts that pass the throttle, whatever their password turns out to be. */
  const attempts = (t: LoginThrottle, username: string, ip: string | null, count: number) =>
    Array.from({ length: count }, () => t.reserve(username, ip)).filter((wait) => wait === 0)
      .length;

  beforeEach(() => {
    now = 1_000_000;
  });

  it("locks a username and address out after the fifth attempt, for fifteen minutes", () => {
    const t = throttle();
    expect(attempts(t, "alice", "1.2.3.4", MAX_FAILURES)).toBe(MAX_FAILURES);
    expect(t.reserve("alice", "1.2.3.4")).toBe(LOCKOUT_MS);
    now += LOCKOUT_MS;
    expect(t.reserve("alice", "1.2.3.4")).toBe(0);
  });

  it("counts attempts that have not finished yet, so a parallel burst is limited", () => {
    const t = throttle();
    // Twenty attempts reserved before any of them has been answered.
    expect(attempts(t, "alice", "1.2.3.4", 20)).toBe(MAX_FAILURES);
  });

  it("does not let failures from one address lock the user out elsewhere", () => {
    const t = throttle();
    attempts(t, "alice", "6.6.6.6", MAX_FAILURES);
    expect(t.reserve("alice", "1.2.3.4")).toBe(0);
    expect(t.reserve("ALICE", "6.6.6.6")).toBeGreaterThan(0);
  });

  it("stops a guesser who rotates addresses, by username", () => {
    const t = throttle();
    let passed = 0;
    for (let i = 0; i < MAX_FAILURES_PER_USERNAME + 20; i++) {
      if (t.reserve("carol", `10.0.0.${i}`) === 0) passed++;
    }
    expect(passed).toBe(MAX_FAILURES_PER_USERNAME);
    // Even a fresh address is refused while the username is locked.
    expect(t.reserve("carol", "10.9.9.9")).toBeGreaterThan(0);
  });

  it("forgets attempts older than the window, and a success gives its attempt back", () => {
    const t = throttle();
    attempts(t, "bob", null, MAX_FAILURES - 1);
    now += WINDOW_MS;
    expect(t.reserve("bob", null)).toBe(0);
    t.recordSuccess("bob", null);
    expect(attempts(t, "bob", null, MAX_FAILURES)).toBe(MAX_FAILURES);
  });

  it("stays within its cap under a spray of random usernames, and prunes what expired", () => {
    const t = throttle(100);
    for (let i = 0; i < 1_000; i++) t.reserve(`user-${i}`, "1.1.1.1");
    expect(t.size).toBeLessThanOrEqual(100);
    now += WINDOW_MS + 1;
    t.reserve("fresh", "1.1.1.1");
    expect(t.size).toBeLessThanOrEqual(2);
  });
});
