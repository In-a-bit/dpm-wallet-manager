import crypto from "node:crypto";
import { promisify } from "node:util";

import { validationFailed } from "../errors";

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

/** Shortest password accepted. Long enough that a stolen hash is not worth cracking. */
export const MIN_PASSWORD_LENGTH = 12;
/** Upper bound, so a megabyte "password" cannot be used to burn CPU in scrypt. */
export const MAX_PASSWORD_LENGTH = 256;

/**
 * The one rule a new password must meet. Length is what makes a password hard to guess; composition
 * rules mostly produce `Password1!`.
 */
export function assertPasswordAcceptable(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw validationFailed(`A password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw validationFailed(`A password can have at most ${MAX_PASSWORD_LENGTH} characters`);
  }
}

/**
 * scrypt rather than the HMAC the API keys use: a password is chosen by a person, so it carries
 * little entropy, and the only defence for a stolen hash is making each guess expensive.
 * N=2^15, r=8 costs about 32 MiB and some tens of milliseconds per attempt.
 */
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;
const MAX_MEMORY = 64 * 1024 * 1024;
const SCHEME = "scrypt";

/** `scrypt$<N>$<r>$<p>$<salt>$<hash>`, salt and hash base64url. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, PARAMS);
  return [
    SCHEME,
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

/** Constant-time check. A malformed stored hash verifies as false rather than throwing. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) return false;
  const actual = await derive(password, parsed.salt, parsed.params);
  return actual.length === parsed.hash.length && crypto.timingSafeEqual(actual, parsed.hash);
}

/**
 * Burns the same work as a real check, for a username that does not exist. Without it, how long
 * a failed sign-in takes would tell an attacker which usernames are real.
 */
export async function burnPasswordCheck(password: string): Promise<void> {
  await derive(password, DUMMY_SALT, PARAMS);
}

const DUMMY_SALT = crypto.randomBytes(SALT_BYTES);

type Params = { N: number; r: number; p: number };

function derive(password: string, salt: Buffer, params: Params): Promise<Buffer> {
  return scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { ...params, maxmem: MAX_MEMORY });
}

function parseHash(stored: string): { params: Params; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== SCHEME) return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every(Number.isSafeInteger)) return undefined;
  return {
    params: { N, r, p },
    salt: Buffer.from(parts[4] as string, "base64url"),
    hash: Buffer.from(parts[5] as string, "base64url"),
  };
}
