import { LOCKOUT_MS, LoginThrottle, MAX_FAILURES, WINDOW_MS } from "./login-throttle";

describe("LoginThrottle", () => {
  let now = 0;
  const throttle = () => new LoginThrottle(() => now);

  beforeEach(() => {
    now = 1_000_000;
  });

  it("locks a username and address out after the fifth failure, for fifteen minutes", () => {
    const t = throttle();
    for (let i = 0; i < MAX_FAILURES - 1; i++) t.recordFailure("alice", "1.2.3.4");
    expect(t.retryAfterMs("alice", "1.2.3.4")).toBe(0);
    t.recordFailure("alice", "1.2.3.4");
    expect(t.retryAfterMs("alice", "1.2.3.4")).toBe(LOCKOUT_MS);
    now += LOCKOUT_MS;
    expect(t.retryAfterMs("alice", "1.2.3.4")).toBe(0);
  });

  it("does not let failures from one address lock the user out elsewhere", () => {
    const t = throttle();
    for (let i = 0; i < MAX_FAILURES; i++) t.recordFailure("alice", "6.6.6.6");
    expect(t.retryAfterMs("alice", "1.2.3.4")).toBe(0);
    expect(t.retryAfterMs("ALICE", "6.6.6.6")).toBeGreaterThan(0);
  });

  it("forgets failures older than the window, and all of them on success", () => {
    const t = throttle();
    for (let i = 0; i < MAX_FAILURES - 1; i++) t.recordFailure("bob", null);
    now += WINDOW_MS;
    t.recordFailure("bob", null);
    expect(t.retryAfterMs("bob", null)).toBe(0);
    t.recordSuccess("bob", null);
    for (let i = 0; i < MAX_FAILURES - 1; i++) t.recordFailure("bob", null);
    expect(t.retryAfterMs("bob", null)).toBe(0);
  });
});
