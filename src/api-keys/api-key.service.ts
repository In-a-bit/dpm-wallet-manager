import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import type { Config } from "../config";
import { hashApiKey, mintApiKey, parseApiKey } from "../crypto/api-key-format";
import { decryptCredential, encryptCredential } from "../crypto/credential-encryption";
import type { Secrets } from "../crypto/secrets";
import type { ApiKeyRole } from "../db/entities";
import { ApiKeyRepository, type ApiKey } from "../db/repositories/api-key.repo";
import { ManagerError, validationFailed } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { CONFIG, SECRETS } from "../tokens";
import { ApiKeyDto, MintedApiKeyDto } from "./dto/api-key-response.dto";

/** Five reveals a minute per key: enough for a human, useless for scraping the table. */
const REVEAL_LIMIT = 5;
const REVEAL_WINDOW_MS = 60_000;

@Injectable()
export class ApiKeyService {
  private readonly reveals = new Map<string, number[]>();

  constructor(
    private readonly keys: ApiKeyRepository,
    private readonly audit: AuditLog,
    @Inject(SECRETS) private readonly secrets: Secrets,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async list(): Promise<ApiKeyDto[]> {
    return (await this.keys.list()).map(toView);
  }

  async get(id: string): Promise<ApiKeyDto> {
    return toView(await this.require(id));
  }

  async create(
    input: { role: ApiKeyRole; name: string; expiresAt?: string },
    actor: Actor | undefined,
  ): Promise<MintedApiKeyDto> {
    const created = await this.mint({
      role: input.role,
      name: input.name,
      expiresAt: input.expiresAt ?? null,
      rotatedFromId: null,
      createdByKeyId: actor?.keyId ?? null,
      createdByUserId: actor?.userId ?? null,
    });
    await this.audit.record({
      actor,
      action: AuditAction.KeyCreate,
      outcome: AuditOutcome.Success,
      detail: { keyId: created.id, role: created.role, prefix: created.prefix, name: created.name },
    });
    return created;
  }

  /**
   * Mints a replacement and gives the outgoing key a deadline instead of killing it.
   *
   * Rotation without an overlap would mean every caller has to swap its credential at the same
   * instant the new one is minted, which nothing distributed can do — so in practice keys never
   * get rotated at all. A grace window turns it into: deploy the new key, then let the old one
   * lapse.
   */
  async rotate(
    id: string,
    graceSeconds: number,
    actor: Actor | undefined,
  ): Promise<{ created: MintedApiKeyDto; rotated: ApiKeyDto }> {
    const existing = await this.require(id);
    if (existing.status !== "active") {
      throw new ManagerError("API_KEY_REVOKED", "A revoked key cannot be rotated", {
        details: { id },
      });
    }

    const created = await this.mint({
      role: existing.role,
      name: existing.name,
      expiresAt: null,
      rotatedFromId: existing.id,
      createdByKeyId: actor?.keyId ?? null,
      createdByUserId: actor?.userId ?? null,
    });

    const expiresAt = new Date(Date.now() + graceSeconds * 1000).toISOString();
    const rotated =
      graceSeconds > 0
        ? await this.keys.setExpiry(existing.id, expiresAt)
        : await this.keys.revoke(existing.id, new Date().toISOString());

    await this.audit.record({
      actor,
      action: AuditAction.KeyRotate,
      outcome: AuditOutcome.Success,
      detail: {
        rotatedKeyId: existing.id,
        rotatedPrefix: existing.prefix,
        newKeyId: created.id,
        newPrefix: created.prefix,
        graceSeconds,
      },
    });
    return { created, rotated: toView(rotated ?? existing) };
  }

  /**
   * Returns the full key. This is the deliberate trade the design makes: the UI can show an
   * operator their own credential instead of forcing a rotation every time one is mislaid, at
   * the cost of the key being recoverable by anyone holding both an admin key and the master
   * key. Admin-only, throttled, and always audited — the audit row is what makes the trade
   * accountable rather than merely convenient.
   */
  async reveal(id: string, actor: Actor): Promise<MintedApiKeyDto> {
    const stored = await this.require(id);
    this.assertRevealAllowed(id);

    const key = decryptCredential(this.secrets.encryptionKey, stored.secretEncrypted);
    await this.audit.record({
      actor,
      action: AuditAction.KeyReveal,
      outcome: AuditOutcome.Success,
      detail: { keyId: stored.id, prefix: stored.prefix, role: stored.role },
    });
    return { ...toView(stored), key };
  }

  /**
   * Revoking the last usable admin key would lock the install out of its own administration with
   * no way back short of editing the database, so it is refused. Expired keys do not count as
   * usable: leaving one behind would be the same lockout with an extra step.
   */
  async revoke(id: string, actor: Actor): Promise<ApiKeyDto> {
    const stored = await this.require(id);
    if (stored.status !== "active") return toView(stored);

    const now = new Date().toISOString();
    if (stored.role === "admin" && (await this.keys.countUsable("admin", now, id)) === 0) {
      await this.audit.record({
        actor,
        action: AuditAction.KeyRevoke,
        outcome: AuditOutcome.Denied,
        detail: { keyId: id, prefix: stored.prefix, reason: "last usable admin key" },
      });
      throw new ManagerError(
        "LAST_ADMIN_KEY",
        "This is the last usable admin key; create another before revoking it",
        { details: { id } },
      );
    }

    const revoked = await this.keys.revoke(id, now);
    await this.audit.record({
      actor,
      action: AuditAction.KeyRevoke,
      outcome: AuditOutcome.Success,
      detail: { keyId: id, prefix: stored.prefix, role: stored.role },
    });
    return toView(revoked ?? stored);
  }

  /**
   * Mints the first admin key, and only ever the first: a service that would re-seed itself on an
   * empty table could be made to hand out a fresh admin credential by dropping one row.
   *
   * A configured `DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY` is adopted verbatim so an operator can
   * provision from their own secret store rather than copying a printed value out of a log.
   */
  async bootstrap(name = "bootstrap"): Promise<{ key: MintedApiKeyDto; created: boolean }> {
    if ((await this.keys.countAll()) > 0) {
      const existing = await this.keys.list();
      const admin = existing.find((key) => key.role === "admin" && key.status === "active");
      if (!admin) {
        throw new ManagerError(
          "LAST_ADMIN_KEY",
          "Keys exist but none is an active admin key; reveal or restore one rather than re-bootstrapping",
        );
      }
      return { key: { ...toView(admin), key: "" }, created: false };
    }

    const configured = this.config.bootstrapAdminKey;
    if (configured) {
      const parsed = parseApiKey(configured);
      if (!parsed) {
        throw validationFailed(
          "DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY is not a well-formed key (dpmm_<env>_ad_<32 chars>)",
        );
      }
      if (parsed.role !== "admin") {
        throw validationFailed("DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY must be an admin key");
      }
    }

    const created = await this.mint({
      role: "admin",
      name,
      expiresAt: null,
      rotatedFromId: null,
      createdByKeyId: null,
      createdByUserId: null,
      presetKey: configured,
    });
    await this.audit.record({
      action: AuditAction.KeyBootstrap,
      outcome: AuditOutcome.Success,
      detail: { keyId: created.id, prefix: created.prefix, fromEnv: Boolean(configured) },
    });
    return { key: created, created: true };
  }

  /**
   * The single place a key is written. Both stored forms are derived here — the HMAC that
   * verifies it and the envelope that reveals it — so the two can never disagree about which key
   * a row holds.
   */
  private async mint(input: {
    role: ApiKeyRole;
    name: string;
    expiresAt: string | null;
    rotatedFromId: string | null;
    createdByKeyId: string | null;
    createdByUserId: string | null;
    presetKey?: string | undefined;
  }): Promise<MintedApiKeyDto> {
    const parsed = input.presetKey
      ? parseApiKey(input.presetKey)
      : mintApiKey(this.config.keyEnvironment, input.role);
    if (!parsed) throw validationFailed("Supplied key is not well-formed");

    const stored = await this.keys.insert({
      id: randomUUID(),
      role: input.role,
      name: input.name,
      prefix: parsed.prefix,
      hash: hashApiKey(this.secrets.apiKeyPepper, parsed.key),
      secretEncrypted: encryptCredential(this.secrets.encryptionKey, parsed.key),
      expiresAt: input.expiresAt,
      rotatedFromId: input.rotatedFromId,
      createdByKeyId: input.createdByKeyId,
      createdByUserId: input.createdByUserId,
      createdAt: new Date().toISOString(),
    });
    return { ...toView(stored), key: parsed.key };
  }

  private async require(id: string): Promise<ApiKey> {
    const stored = await this.keys.findById(id);
    if (!stored) throw new ManagerError("API_KEY_NOT_FOUND", `No API key with id "${id}"`);
    return stored;
  }

  /**
   * In-process, which is enough for what this defends against: a human clicking "reveal" in a
   * loop, or a script walking the key list. A distributed limiter would need shared state for no
   * additional protection — an attacker holding an admin key has already won.
   */
  private assertRevealAllowed(id: string): void {
    const now = Date.now();
    const recent = (this.reveals.get(id) ?? []).filter((at) => now - at < REVEAL_WINDOW_MS);
    if (recent.length >= REVEAL_LIMIT) {
      throw new ManagerError(
        "RATE_LIMITED",
        `Too many reveals for this key; try again in a minute (limit ${REVEAL_LIMIT}/minute)`,
      );
    }
    this.reveals.set(id, [...recent, now]);
  }
}

function toView(key: ApiKey): ApiKeyDto {
  return {
    id: key.id,
    role: key.role,
    name: key.name,
    prefix: key.prefix,
    status: key.status,
    expiresAt: key.expiresAt,
    lastUsedAt: key.lastUsedAt,
    revokedAt: key.revokedAt,
    rotatedFromId: key.rotatedFromId,
    createdByKeyId: key.createdByKeyId,
    createdByUserId: key.createdByUserId,
    createdAt: key.createdAt,
  };
}
