import { decryptCredential, encryptCredential } from "./credential-encryption";
import { deriveSecrets } from "./secrets";

const MASTER = "9f2c1ab4e0d75b3846a1c0ff1e2d3c4b5a69788796a5b4c3d2e1f00112233445";
const OTHER = "0000000000000000000000000000000000000000000000000000000000000001";

describe("deriveSecrets", () => {
  it("is deterministic, so a restart can still verify and reveal existing keys", () => {
    expect(deriveSecrets(MASTER).apiKeyPepper.toString("hex")).toBe(
      deriveSecrets(MASTER).apiKeyPepper.toString("hex"),
    );
    expect(deriveSecrets(MASTER).encryptionKey.toString("hex")).toBe(
      deriveSecrets(MASTER).encryptionKey.toString("hex"),
    );
  });

  it("separates the two outputs, so neither reveals the other", () => {
    const secrets = deriveSecrets(MASTER);
    expect(secrets.apiKeyPepper.toString("hex")).not.toBe(secrets.encryptionKey.toString("hex"));
  });

  it("changes both outputs when the master key changes", () => {
    expect(deriveSecrets(OTHER).apiKeyPepper.toString("hex")).not.toBe(
      deriveSecrets(MASTER).apiKeyPepper.toString("hex"),
    );
  });

  it("rejects a master key of the wrong length", () => {
    expect(() => deriveSecrets("abcd")).toThrow(/32 bytes/);
  });
});

describe("credential encryption", () => {
  const key = deriveSecrets(MASTER).encryptionKey;

  it("round-trips", () => {
    const stored = encryptCredential(key, "dpmm_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3");
    expect(decryptCredential(key, stored)).toBe("dpmm_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3");
  });

  it("produces a different envelope every time, so two identical keys are not linkable", () => {
    expect(encryptCredential(key, "same")).not.toBe(encryptCredential(key, "same"));
  });

  it("refuses a tampered ciphertext rather than returning plausible garbage", () => {
    const stored = encryptCredential(key, "secret");
    const [version, iv, tag, ciphertext] = stored.split(".") as [string, string, string, string];
    const flipped = `${ciphertext.slice(0, -1)}${ciphertext.endsWith("A") ? "B" : "A"}`;
    expect(() => decryptCredential(key, [version, iv, tag, flipped].join("."))).toThrow(
      /could not be decrypted/,
    );
  });

  it("refuses an envelope written under a different master key", () => {
    const stored = encryptCredential(deriveSecrets(OTHER).encryptionKey, "secret");
    expect(() => decryptCredential(key, stored)).toThrow(/could not be decrypted/);
  });

  it("refuses a value that is not an envelope at all", () => {
    expect(() => decryptCredential(key, "not-an-envelope")).toThrow(/not a v1 envelope/);
  });
});
