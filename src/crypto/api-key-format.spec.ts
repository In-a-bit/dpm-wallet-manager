import { hashApiKey, hashesEqual, mintApiKey, parseApiKey } from "./api-key-format";
import { deriveSecrets } from "./secrets";

const PEPPER = deriveSecrets(
  "9f2c1ab4e0d75b3846a1c0ff1e2d3c4b5a69788796a5b4c3d2e1f00112233445",
).apiKeyPepper;

describe("api key format", () => {
  it("mints a key whose prefix is a strict, non-secret prefix of the key", () => {
    const minted = mintApiKey("live", "admin");
    expect(minted.key).toMatch(/^dpmm_live_ad_[a-z0-9]{32}$/);
    expect(minted.key.startsWith(minted.prefix)).toBe(true);
    expect(minted.prefix).toHaveLength("dpmm_live_ad_".length + 8);
  });

  it("round-trips through parse", () => {
    const minted = mintApiKey("test", "operator");
    expect(parseApiKey(minted.key)).toEqual({
      key: minted.key,
      prefix: minted.prefix,
      environment: "test",
      role: "operator",
    });
  });

  it("gives a readonly key its own role code, and reads it back", () => {
    const minted = mintApiKey("live", "readonly");
    expect(minted.key).toMatch(/^dpmm_live_ro_[a-z0-9]{32}$/);
    expect(parseApiKey(minted.key)?.role).toBe("readonly");
  });

  it("never repeats a secret", () => {
    const keys = new Set(Array.from({ length: 200 }, () => mintApiKey("live", "admin").key));
    expect(keys.size).toBe(200);
  });

  it.each([
    ["empty", ""],
    ["another vendor's key", "sk_live_abc123"],
    ["wrong namespace", "dpmx_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3"],
    ["unknown role", "dpmm_live_xx_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3"],
    ["short secret", "dpmm_live_ad_k7m2q9x4"],
    ["secret outside the alphabet", "dpmm_live_ad_K7M2Q9X4B3N8V3C6Z2S5T2R7W4Y9P8J3"],
    ["extra segment", "dpmm_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3_x"],
  ])("rejects %s", (_name, presented) => {
    expect(parseApiKey(presented)).toBeUndefined();
  });

  it("hashes deterministically and compares in constant time", () => {
    const minted = mintApiKey("live", "admin");
    const hash = hashApiKey(PEPPER, minted.key);
    expect(hashApiKey(PEPPER, minted.key)).toBe(hash);
    expect(hashesEqual(hash, hashApiKey(PEPPER, minted.key))).toBe(true);
  });

  it("does not match a key differing by a single character", () => {
    const minted = mintApiKey("live", "admin");
    const tampered = `${minted.key.slice(0, -1)}${minted.key.endsWith("z") ? "x" : "z"}`;
    expect(hashesEqual(hashApiKey(PEPPER, minted.key), hashApiKey(PEPPER, tampered))).toBe(false);
  });

  it("gives a different hash under a different pepper", () => {
    const minted = mintApiKey("live", "admin");
    const other = deriveSecrets(
      "0000000000000000000000000000000000000000000000000000000000000001",
    ).apiKeyPepper;
    expect(hashApiKey(other, minted.key)).not.toBe(hashApiKey(PEPPER, minted.key));
  });
});
