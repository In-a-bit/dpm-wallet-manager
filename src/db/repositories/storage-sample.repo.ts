import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { StorageSampleEntity } from "../entities";

export type TableStat = { db: "manager"; name: string; bytes: number; estRows: number };

export type StorageSample = {
  at: string;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPercent: number | null;
  walletDbBytes: number | null;
  managerDbBytes: number;
  tables: TableStat[];
  growthBytesPerDay: number | null;
  daysToFull: number | null;
  level: string;
};

const MANAGER_TABLES = ["operations", "audit_events", "idempotency_keys"];

@Injectable()
export class StorageSampleRepository {
  private readonly samples: Repository<StorageSampleEntity>;

  constructor(@Inject(DB) db: Db) {
    this.samples = db.getRepository(StorageSampleEntity);
  }

  async insert(sample: StorageSample): Promise<void> {
    const { tables, ...rest } = sample;
    await this.samples.insert({ ...rest, tablesJson: JSON.stringify(tables) });
  }

  async latest(): Promise<StorageSample | undefined> {
    const row = await this.samples.find({ order: { at: "DESC", id: "DESC" }, take: 1 });
    return row[0] ? toSample(row[0]) : undefined;
  }

  /** Samples at or after `since`, oldest first. */
  async since(since: string): Promise<StorageSample[]> {
    const rows = await this.samples
      .createQueryBuilder("s")
      .where("s.at >= :since", { since })
      .orderBy("s.at", "ASC")
      .addOrderBy("s.id", "ASC")
      .getMany();
    return rows.map(toSample);
  }

  async trimOlderThan(cutoff: string): Promise<number> {
    const result = await this.samples
      .createQueryBuilder()
      .delete()
      .where("at < :cutoff", { cutoff })
      .execute();
    return result.affected ?? 0;
  }

  /**
   * Sizes of this service's database and of dpm-wallet's. The wallet database lives under another
   * name on the same server; where it does not exist (tests, dev) it is null.
   */
  async databaseSizes(): Promise<{ manager: number; wallet: number | null }> {
    const manager: { bytes: string }[] = await this.samples.query(
      `SELECT pg_database_size(current_database())::text AS bytes`,
    );
    const wallet: { bytes: string }[] = await this.samples.query(
      `SELECT pg_database_size(datname)::text AS bytes FROM pg_database WHERE datname = 'dpm_wallet'`,
    );
    return {
      manager: Number(manager[0]?.bytes ?? 0),
      wallet: wallet[0] ? Number(wallet[0].bytes) : null,
    };
  }

  /** Total size and the planner's row estimate of the manager's own big tables. */
  async tableStats(): Promise<TableStat[]> {
    const rows: { name: string; bytes: string; rows: string }[] = await this.samples.query(
      `SELECT c.relname AS name, pg_total_relation_size(c.oid)::text AS bytes,
              GREATEST(c.reltuples, 0)::bigint::text AS rows
       FROM pg_class c
       WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace
         AND c.relname = ANY($1)
       ORDER BY c.relname`,
      [MANAGER_TABLES],
    );
    return rows.map((r) => ({
      db: "manager",
      name: r.name,
      bytes: Number(r.bytes),
      estRows: Number(r.rows),
    }));
  }

  /**
   * The oldest record only an archive may remove: a withdraw, or an audit event that is not a
   * routine success. Both lookups walk an index in time order and stop at the first match.
   */
  async oldestImportantAt(): Promise<string | null> {
    const ops: { at: Date | null }[] = await this.samples.query(
      `SELECT created_at AS at FROM operations WHERE kind = 'withdraw' ORDER BY created_at LIMIT 1`,
    );
    const audit: { at: Date | null }[] = await this.samples.query(
      `SELECT created_at AS at FROM audit_events
       WHERE NOT (outcome = 'success' AND action IN ('sign.order', 'sign.cancel', 'meta.allowance',
                                                     'meta.redeem', 'meta.split', 'meta.merge'))
       ORDER BY created_at LIMIT 1`,
    );
    const times = [ops[0]?.at, audit[0]?.at]
      .filter((t): t is Date => t instanceof Date)
      .map((t) => t.getTime());
    return times.length === 0 ? null : new Date(Math.min(...times)).toISOString();
  }
}

function toSample(row: StorageSampleEntity): StorageSample {
  return {
    at: row.at,
    diskTotalBytes: row.diskTotalBytes,
    diskFreeBytes: row.diskFreeBytes,
    diskUsedPercent: row.diskUsedPercent,
    walletDbBytes: row.walletDbBytes,
    managerDbBytes: row.managerDbBytes,
    tables: JSON.parse(row.tablesJson) as TableStat[],
    growthBytesPerDay: row.growthBytesPerDay,
    daysToFull: row.daysToFull,
    level: row.level,
  };
}
