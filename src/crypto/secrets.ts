import crypto from "node:crypto";

import { asEncryptionKey, KEY_BYTES, type EncryptionKey } from "./credential-encryption";

/**
 * The two secrets the API-key store needs, both derived from the single configured master key.
 *
 * One root secret rather than two environment variables because they must always change
 * together: a pepper that no longer matches the stored hashes makes every key unverifiable, and
 * an encryption key that no longer matches the stored envelopes makes every key unrevealable.
 * Deriving both from one value removes the failure mode where an operator rotates one and not
 * the other.
 *
 * HKDF-SHA256 with distinct `info` strings, so neither output tells you anything about the other.
 */
export type Secrets = {
  /** HMAC key the presented API key is hashed under before comparison. */
  apiKeyPepper: Buffer;
  /** AES-256-GCM key protecting the revealable copy of each API key. */
  encryptionKey: EncryptionKey;
};

const SALT = Buffer.from("dpm-wallet-manager/v1", "utf8");
const PEPPER_BYTES = 32;

export function deriveSecrets(masterKeyHex: string): Secrets {
  const master = Buffer.from(masterKeyHex, "hex");
  if (master.length !== KEY_BYTES) {
    throw new Error(`master key must be ${KEY_BYTES} bytes of hex`);
  }
  return {
    apiKeyPepper: expand(master, "api-key-pepper", PEPPER_BYTES),
    encryptionKey: asEncryptionKey(expand(master, "credential-encryption", KEY_BYTES)),
  };
}

function expand(master: Buffer, info: string, bytes: number): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", master, SALT, Buffer.from(info, "utf8"), bytes));
}
