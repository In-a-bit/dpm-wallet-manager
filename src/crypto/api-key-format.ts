import crypto from "node:crypto";

import type { ApiKeyRole } from "../db/entities";

/**
 * The shape of an API key: `dpmm_<env>_<role>_<secret>`, e.g.
 * `dpmm_live_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3`.
 *
 * Four things it buys, all of them operational rather than cryptographic:
 *
 * - `dpmm_` makes a leaked key greppable, in a log dump or a public repository scan.
 * - `<env>` means a staging key pasted into production is obvious on sight rather than a
 *   mysterious 401.
 * - `<role>` lets a human reading a config file tell an admin key from an operator one.
 * - the **prefix** — everything up to and including the first 8 characters of the secret — is a
 *   non-secret handle. It is what the guard looks the row up by, what the UI displays, and what a
 *   failed-authentication log line carries. Without it the guard would have to hash-compare every
 *   row in the table.
 *
 * The secret is 160 bits from `randomBytes`, which is why verification can be a plain HMAC rather
 * than a password KDF: there is nothing to brute-force.
 */
const NAMESPACE = "dpmm";
const SECRET_CHARS = 32;
const PREFIX_SECRET_CHARS = 8;

/** Crockford-ish base32 without the vowels that form words, or the 0/O and 1/l lookalikes. */
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

const ROLE_CODES: Record<ApiKeyRole, string> = { admin: "ad", operator: "op" };
const ROLE_BY_CODE: Record<string, ApiKeyRole> = { ad: "admin", op: "operator" };

export type ParsedApiKey = {
  /** The full presented key, as given. */
  key: string;
  /** The indexed, non-secret handle: `dpmm_<env>_<role>_<first 8 secret chars>`. */
  prefix: string;
  environment: string;
  /** What the key *claims* to be. The database row is authoritative; this is a hint. */
  role: ApiKeyRole;
};

export function mintApiKey(environment: string, role: ApiKeyRole): ParsedApiKey {
  const secret = randomSecret(SECRET_CHARS);
  const key = [NAMESPACE, environment, ROLE_CODES[role], secret].join("_");
  return {
    key,
    prefix: [NAMESPACE, environment, ROLE_CODES[role], secret.slice(0, PREFIX_SECRET_CHARS)].join(
      "_",
    ),
    environment,
    role,
  };
}

/**
 * Splits a presented key into its parts, or returns undefined if it is not one of ours.
 *
 * Rejecting early on shape costs the attacker nothing they did not already know — the format is
 * public — and saves a database round trip on every stray request that reaches the header.
 */
export function parseApiKey(presented: string): ParsedApiKey | undefined {
  const parts = presented.split("_");
  if (parts.length !== 4) return undefined;
  const [namespace, environment, roleCode, secret] = parts as [string, string, string, string];
  if (namespace !== NAMESPACE) return undefined;
  if (!/^[a-z0-9]{2,12}$/.test(environment)) return undefined;
  const role = ROLE_BY_CODE[roleCode];
  if (!role) return undefined;
  if (secret.length !== SECRET_CHARS) return undefined;
  if (!isAlphabet(secret)) return undefined;
  return {
    key: presented,
    prefix: [namespace, environment, roleCode, secret.slice(0, PREFIX_SECRET_CHARS)].join("_"),
    environment,
    role,
  };
}

/**
 * HMAC-SHA256 under the derived pepper, hex.
 *
 * Deliberately not Argon2 or bcrypt. Those exist to make a *low-entropy* secret expensive to
 * guess; this secret carries 160 bits of entropy, so guessing is already impossible, and a slow
 * KDF would only put tens of milliseconds on the authentication path of every request. The
 * pepper is what stops an attacker who has the table — but not the master key — from confirming
 * a guessed key offline.
 */
export function hashApiKey(pepper: Buffer, key: string): string {
  return crypto.createHmac("sha256", pepper).update(key, "utf8").digest("hex");
}

/** Constant-time comparison of two hex digests of equal, non-secret length. */
export function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Rejection sampling rather than `% ALPHABET.length`: the alphabet's length does not divide 256,
 * so the modulo would make the first few characters marginally more likely than the rest.
 */
function randomSecret(length: number): string {
  let out = "";
  while (out.length < length) {
    for (const byte of crypto.randomBytes(length * 2)) {
      if (byte >= Math.floor(256 / ALPHABET.length) * ALPHABET.length) continue;
      out += ALPHABET[byte % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}

function isAlphabet(value: string): boolean {
  return [...value].every((char) => ALPHABET.includes(char));
}
