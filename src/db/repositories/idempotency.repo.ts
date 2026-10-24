import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { IdempotencyKeyEntity } from "../entities";

export type IdempotencyRecord = { requestHash: string; responseJson: string };

/** Records older than this are dropped at boot: a retry window measured in days is generous. */
const RETENTION_DAYS = 7;
/** A key is honoured for this long (documented on the `Idempotency-Key` header). */
const WINDOW_MS = 24 * 60 * 60 * 1000;

@Injectable()
export class IdempotencyRepository {
  private readonly records: Repository<IdempotencyKeyEntity>;

  constructor(@Inject(DB) db: Db) {
    this.records = db.getRepository(IdempotencyKeyEntity);
  }

  async find(
    actor: string,
    key: string,
    now: Date = new Date(),
  ): Promise<IdempotencyRecord | undefined> {
    const row = await this.records.findOneBy({ actor, key });
    if (!row) return undefined;
    if (Date.parse(row.createdAt) < now.getTime() - WINDOW_MS) return undefined;
    return { requestHash: row.requestHash, responseJson: row.responseJson };
  }

  /**
   * First writer wins. Two concurrent retries of the same request must not both be treated as the
   * original, so the insert ignores a conflict rather than overwriting — the loser then reads the
   * winner's stored response on its next attempt.
   */
  async save(actor: string, key: string, record: IdempotencyRecord, now: string): Promise<void> {
    // An expired row still occupies the key, so it is replaced rather than ignored.
    await this.records
      .createQueryBuilder()
      .delete()
      .where("actor = :actor AND key = :key AND created_at < :cutoff", {
        actor,
        key,
        cutoff: new Date(Date.parse(now) - WINDOW_MS).toISOString(),
      })
      .execute();
    await this.records
      .createQueryBuilder()
      .insert()
      .values({ actor, key, ...record, createdAt: now })
      .orIgnore()
      .execute();
  }

  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const result = await this.records
      .createQueryBuilder()
      .delete()
      .where("created_at < :cutoff", { cutoff })
      .execute();
    return result.affected ?? 0;
  }
}
