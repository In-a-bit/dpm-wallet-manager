import crypto from "node:crypto";

import { ManagerError } from "../errors";

/**
 * Encrypts the revealable copy of an API key. AES-256-GCM, so a modified ciphertext fails to
 * decrypt rather than yielding plausible garbage.
 *
 * The stored form is `v1.<iv>.<tag>.<ciphertext>`, each part base64url. The version prefix exists
 * so a future scheme can be told apart from this one without guessing.
 *
 * Ported from dpm-wallet's `src/crypto/credential-encryption.ts`; the key now arrives derived
 * (see `secrets.ts`) rather than parsed straight from an environment variable.
 */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
export const KEY_BYTES = 32;

/** The AES key, HKDF-derived from the configured master key. */
export type EncryptionKey = Buffer & { readonly __encryptionKey: unique symbol };

export function asEncryptionKey(key: Buffer): EncryptionKey {
  if (key.length !== KEY_BYTES) throw new Error(`encryption key must be ${KEY_BYTES} bytes`);
  return key as EncryptionKey;
}

export function encryptCredential(key: EncryptionKey, plaintext: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, encode(iv), encode(cipher.getAuthTag()), encode(ciphertext)].join(".");
}

/**
 * Reverses encryptCredential. Every failure — wrong key, wrong format, tampered ciphertext —
 * arrives as the same error: there is no fallback that could produce a usable credential, and
 * continuing without one would fail later with a less obvious cause.
 */
export function decryptCredential(key: EncryptionKey, stored: string): string {
  const [iv, tag, ciphertext] = parseEnvelope(stored);
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch (cause) {
    throw new ManagerError(
      "INTERNAL_ERROR",
      "Stored credential could not be decrypted; DPM_WALLET_MANAGER_MASTER_KEY does not match the database",
      { cause },
    );
  }
}

function parseEnvelope(stored: string): [iv: Buffer, tag: Buffer, ciphertext: Buffer] {
  const parts = stored.split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new ManagerError("INTERNAL_ERROR", `Stored credential is not a ${VERSION} envelope`);
  }
  const [, iv, tag, ciphertext] = parts as [string, string, string, string];
  return [decode(iv), decode(tag), decode(ciphertext)];
}

function encode(bytes: Buffer): string {
  return bytes.toString("base64url");
}

function decode(value: string): Buffer {
  return Buffer.from(value, "base64url");
}
