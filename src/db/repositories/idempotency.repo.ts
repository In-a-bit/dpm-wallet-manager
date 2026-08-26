import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { IdempotencyKeyEntity } from "../entities";

export type IdempotencyRecord = { requestHash: string; responseJson: string };

/** Records older than this are dropped at boot: a retry window measured in days is generous. */
const RETENTION_DAYS = 7;

@Injectable()
export class IdempotencyRepository {
  private readonly records: Repository<IdempotencyKeyEntity>;

  constructor(@Inject(DB) db: Db) {
    this.records = db.getRepository(IdempotencyKeyEntity);
  }

  async find(key: string): Promise<IdempotencyRecord | undefined> {
    const row = await this.records.findOneBy({ key });
    return row ? { requestHash: row.requestHash, responseJson: row.responseJson } : undefined;
  }

  /**
   * First writer wins. Two concurrent retries of the same request must not both be treated as the
   * original, so the insert ignores a conflict rather than overwriting — the loser then reads the
   * winner's stored response on its next attempt.
   */
  async save(key: string, record: IdempotencyRecord, now: string): Promise<void> {
    await this.records
      .createQueryBuilder()
      .insert()
      .values({ key, ...record, createdAt: now })
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
