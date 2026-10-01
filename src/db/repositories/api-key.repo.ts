import { Inject, Injectable } from "@nestjs/common";
import { IsNull, MoreThan, type Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { ApiKeyEntity, type ApiKeyRole, type ApiKeyStatus } from "../entities";

export type ApiKey = {
  id: string;
  role: ApiKeyRole;
  name: string;
  prefix: string;
  hash: string;
  secretEncrypted: string;
  status: ApiKeyStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
  createdByKeyId: string | null;
  createdByUserId: string | null;
  createdAt: string;
};

export type NewApiKey = {
  id: string;
  role: ApiKeyRole;
  name: string;
  prefix: string;
  hash: string;
  secretEncrypted: string;
  expiresAt: string | null;
  rotatedFromId: string | null;
  createdByKeyId: string | null;
  createdByUserId: string | null;
  createdAt: string;
};

@Injectable()
export class ApiKeyRepository {
  private readonly keys: Repository<ApiKeyEntity>;

  constructor(@Inject(DB) db: Db) {
    this.keys = db.getRepository(ApiKeyEntity);
  }

  /**
   * The authentication lookup. Selects on the non-secret prefix alone — the hash comparison is
   * the caller's job and has to be constant-time, which a SQL equality is not.
   */
  async findByPrefix(prefix: string): Promise<ApiKey | undefined> {
    const row = await this.keys.findOneBy({ prefix });
    return row ? toApiKey(row) : undefined;
  }

  async findById(id: string): Promise<ApiKey | undefined> {
    const row = await this.keys.findOneBy({ id });
    return row ? toApiKey(row) : undefined;
  }

  async list(): Promise<ApiKey[]> {
    const rows = await this.keys.find({ order: { createdAt: "DESC" } });
    return rows.map(toApiKey);
  }

  async insert(key: NewApiKey): Promise<ApiKey> {
    const row = await this.keys.save(
      this.keys.create({
        ...key,
        status: "active",
        lastUsedAt: null,
        revokedAt: null,
      }),
    );
    return toApiKey(row);
  }

  /**
   * Keys that can still authenticate a request right now: active, and either non-expiring or not
   * yet expired. Used to refuse revoking the last admin key, which would lock the install out of
   * its own administration with no way back in short of a database edit.
   */
  async countUsable(role: ApiKeyRole, now: string, excludeId?: string): Promise<number> {
    const query = this.keys
      .createQueryBuilder("k")
      .where("k.role = :role", { role })
      .andWhere("k.status = 'active'")
      .andWhere("(k.expires_at IS NULL OR k.expires_at > :now)", { now });
    if (excludeId) query.andWhere("k.id <> :excludeId", { excludeId });
    return query.getCount();
  }

  async countAll(): Promise<number> {
    return this.keys.count();
  }

  async revoke(id: string, now: string): Promise<ApiKey | undefined> {
    await this.keys.update({ id }, { status: "revoked", revokedAt: now });
    return this.findById(id);
  }

  async setExpiry(id: string, expiresAt: string): Promise<ApiKey | undefined> {
    await this.keys.update({ id }, { expiresAt });
    return this.findById(id);
  }

  /**
   * Best-effort: the caller throttles this so the authentication path is not a write path on
   * every request. A lost update costs a slightly stale "last used" column and nothing else.
   */
  async touch(id: string, now: string): Promise<void> {
    await this.keys.update({ id }, { lastUsedAt: now });
  }

  /** Exported for the tests that assert the usable-key predicate matches the SQL above. */
  static usableWhere(now: string) {
    return [
      { status: "active" as const, expiresAt: IsNull() },
      { status: "active" as const, expiresAt: MoreThan(now) },
    ];
  }
}

function toApiKey(row: ApiKeyEntity): ApiKey {
  return {
    id: row.id,
    role: row.role,
    name: row.name,
    prefix: row.prefix,
    hash: row.hash,
    secretEncrypted: row.secretEncrypted,
    status: row.status,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    revokedAt: row.revokedAt,
    rotatedFromId: row.rotatedFromId,
    createdByKeyId: row.createdByKeyId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}
