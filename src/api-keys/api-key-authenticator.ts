import { Inject, Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import type { Config } from "../config";
import { hashApiKey, hashesEqual, parseApiKey } from "../crypto/api-key-format";
import type { Secrets } from "../crypto/secrets";
import { ApiKeyRepository, type ApiKey } from "../db/repositories/api-key.repo";
import { unauthorized } from "../errors";
import { logWarn } from "../observability/log";
import { CONFIG, SECRETS } from "../tokens";

/**
 * Writing `last_used_at` on every request would make authentication a write path, and the column
 * is only ever read by a human deciding whether a key is still in use.
 */
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Turns a presented key into an actor, or refuses.
 *
 * Separate from `ApiKeyGuard` so the guard stays a thin piece of Nest plumbing and this — the
 * part with the security properties — can be tested without an HTTP context.
 */
@Injectable()
export class ApiKeyAuthenticator {
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly keys: ApiKeyRepository,
    @Inject(SECRETS) private readonly secrets: Secrets,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async authenticate(
    presented: string,
    context: { ip: string | null; path: string },
  ): Promise<Actor> {
    const parsed = parseApiKey(presented.trim());
    // A malformed key is refused without a database round trip. The format is public, so this
    // leaks nothing an attacker did not already know.
    if (!parsed) throw await this.reject("malformed", undefined, context);

    const stored = await this.keys.findByPrefix(parsed.prefix);
    if (!stored) throw await this.reject("unknown_prefix", parsed.prefix, context);

    // The hash comparison comes before the status checks so that a revoked key and a wrong secret
    // are indistinguishable to someone probing with a guessed key.
    const expected = hashApiKey(this.secrets.apiKeyPepper, parsed.key);
    if (!hashesEqual(expected, stored.hash)) {
      throw await this.reject("bad_secret", parsed.prefix, context);
    }
    if (stored.status !== "active") throw await this.reject("revoked", parsed.prefix, context);
    if (isExpired(stored)) throw await this.reject("expired", parsed.prefix, context);

    void this.touch(stored.id);
    return { keyId: stored.id, role: stored.role, prefix: stored.prefix, name: stored.name };
  }

  /**
   * One message for every failure mode, so a caller cannot distinguish "no such key" from "wrong
   * secret" from "revoked". The reason is logged, never returned — except for the empty-table
   * case, which is a first-run mistake rather than an attack and is worth saying out loud.
   */
  private async reject(
    reason: string,
    prefix: string | undefined,
    context: { ip: string | null; path: string },
  ): Promise<Error> {
    logWarn("auth.failed", { reason, prefix, ip: context.ip, path: context.path });
    if (reason !== "malformed" && (await this.keys.countAll()) === 0) {
      return unauthorized(
        "No API keys exist yet. Restart the service (it mints the first admin key on boot), " +
          "or set DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY to a well-formed dpmm_<env>_ad_… key.",
      );
    }
    return unauthorized();
  }

  /** Throttled and fire-and-forget: a lost update costs a stale column and nothing else. */
  private touch(id: string): void {
    const now = Date.now();
    const previous = this.lastTouched.get(id) ?? 0;
    if (now - previous < TOUCH_INTERVAL_MS) return;
    this.lastTouched.set(id, now);
    void this.keys.touch(id, new Date(now).toISOString()).catch(() => {
      // Roll the marker back so the next request retries rather than waiting out the interval.
      this.lastTouched.delete(id);
    });
  }

  /** Exposed so the bootstrap CLI can label a key with the same environment the service uses. */
  get environment(): string {
    return this.config.keyEnvironment;
  }
}

function isExpired(key: ApiKey): boolean {
  return key.expiresAt !== null && Date.parse(key.expiresAt) <= Date.now();
}
