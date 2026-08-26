import { redact } from "./log";

/**
 * Redaction is a security property, not a formatting preference: one `logInfo("key.created",
 * { key })` would put a live credential wherever stdout is aggregated, from which it cannot be
 * recalled. These pin the rules that stop that.
 */
describe("redact", () => {
  it("replaces secret-bearing fields whatever their casing", () => {
    expect(redact({ apiKey: "dpmm_live_ad_secret", API_KEY: "x", Secret: "y", hash: "z" })).toEqual(
      {
        apiKey: "[redacted]",
        API_KEY: "[redacted]",
        Secret: "[redacted]",
        hash: "[redacted]",
      },
    );
  });

  it("redacts nested and array-held secrets", () => {
    expect(redact({ keys: [{ prefix: "dpmm_live_ad", secret: "s" }] })).toEqual({
      keys: [{ prefix: "dpmm_live_ad", secret: "[redacted]" }],
    });
  });

  it("keeps non-secret fields intact", () => {
    expect(redact({ ref: "mgr:1", index: 0, ok: true })).toEqual({
      ref: "mgr:1",
      index: 0,
      ok: true,
    });
  });

  it("truncates long strings rather than dropping them, so a signature prefix aids support", () => {
    const signature = `0x${"a".repeat(200)}`;
    expect(redact({ signature })).toEqual({ signature: `0x${"a".repeat(18)}…(202)` });
  });

  it("reduces an Error to its name, message and code", () => {
    const err = Object.assign(new Error("boom"), { code: "UPSTREAM_REJECTED" });
    expect(redact({ err })).toEqual({
      err: { name: "Error", message: "boom", code: "UPSTREAM_REJECTED" },
    });
  });

  it("stops recursing on a cycle rather than overflowing the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => JSON.stringify(redact(cyclic))).not.toThrow();
  });
});
