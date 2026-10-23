import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

import {
  decodeCursor,
  encodeCursor,
  FIRST_PAGE_CURSOR,
  invalidCursor,
} from "../../common/dto/cursor";
import { DB } from "../../tokens";
import type { Db } from "../client";
import { AuditEventEntity } from "../entities";

/** Success rows of these actions are routine: retention trims them on a schedule. */
export const ROUTINE_AUDIT_ACTIONS = [
  "sign.order",
  "sign.cancel",
  "meta.allowance",
  "meta.redeem",
  "meta.split",
  "meta.merge",
] as const;

/** SQL over `audit_events` (unaliased) selecting the routine rows retention may delete. */
export const ROUTINE_AUDIT_SQL = `(outcome = 'success' AND action IN (${ROUTINE_AUDIT_ACTIONS.map(
  (action) => `'${action}'`,
).join(", ")}))`;

/**
 * SQL selecting the important rows only an archive removes: everything not routine, except the
 * archive's own `archive.*` trail (create, download, delete, cancel), which is never archived or deleted.
 */
export const IMPORTANT_AUDIT_SQL = `(NOT ${ROUTINE_AUDIT_SQL} AND action NOT LIKE 'archive.%')`;

/** An archive's fixed scope over this table: important rows before `before`, ids up to `maxId`. */
export type ArchiveBound = { before: string; maxId: number };

export type AuditEvent = {
  id: number;
  actorKeyId: string | null;
  actorRole: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  walletId: string | null;
  action: string;
  outcome: string;
  detail: Record<string, unknown> | null;
  requestId: string | null;
  ip: string | null;
  createdAt: string;
};

export type NewAuditEvent = Omit<AuditEvent, "id" | "createdAt"> & { createdAt: string };

export type AuditFilter = {
  action?: string;
  outcome?: string;
  walletId?: string;
  actorKeyId?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
};

export type AuditPage = {
  events: AuditEvent[];
  /** Absent in cursor mode, where counting the whole table is the cost being avoided. */
  total?: number;
  nextCursor: string | null;
};

@Injectable()
export class AuditRepository {
  private readonly events: Repository<AuditEventEntity>;

  constructor(@Inject(DB) db: Db) {
    this.events = db.getRepository(AuditEventEntity);
  }

  async insert(event: NewAuditEvent): Promise<void> {
    await this.events.insert({
      ...event,
      // Stringified here rather than stored as jsonb: the column is read back by a human far more
      // often than it is queried into, and a hand-edited row cannot then break a read.
      detail: event.detail === null ? null : JSON.stringify(event.detail),
    });
  }

  /**
   * Deletes one batch of routine success events older than `cutoff` and returns how many went.
   * Denials, failures and every other action are never touched.
   */
  async purgeRoutine(cutoff: string, batch: number): Promise<number> {
    const result: unknown = await this.events.query(
      `DELETE FROM audit_events WHERE id IN (
         SELECT id FROM audit_events
         WHERE ${ROUTINE_AUDIT_SQL} AND created_at < $1
         ORDER BY created_at, id
         LIMIT $2
       ) RETURNING id`,
      [cutoff, batch],
    );
    return deletedCount(result);
  }

  /** The highest id and the row count of the important rows older than `before`, right now. */
  async importantScope(before: string): Promise<{ maxId: number; rows: number }> {
    const rows: { maxId: number | null; rows: number }[] = await this.events.query(
      `SELECT MAX(id) AS "maxId", COUNT(*)::int AS rows FROM audit_events
       WHERE ${IMPORTANT_AUDIT_SQL} AND created_at < $1`,
      [before],
    );
    return { maxId: rows[0]?.maxId ?? 0, rows: rows[0]?.rows ?? 0 };
  }

  /** How many rows the archive bound covers right now. */
  async countArchived(bound: ArchiveBound): Promise<number> {
    const rows: { rows: number }[] = await this.events.query(
      `SELECT COUNT(*)::int AS rows FROM audit_events
       WHERE ${IMPORTANT_AUDIT_SQL} AND created_at < $1 AND id <= $2`,
      [bound.before, bound.maxId],
    );
    return rows[0]?.rows ?? 0;
  }

  /** One page of an archive's rows, in id order, after `afterId`. */
  async importantPage(bound: ArchiveBound, afterId: number, limit: number): Promise<AuditEvent[]> {
    const rows = await this.events
      .createQueryBuilder("e")
      // Unqualified columns are unambiguous with one table in the query.
      .where(IMPORTANT_AUDIT_SQL)
      .andWhere("e.created_at < :before", { before: bound.before })
      .andWhere("e.id <= :maxId", { maxId: bound.maxId })
      .andWhere("e.id > :afterId", { afterId })
      .orderBy("e.id", "ASC")
      .take(limit)
      .getMany();
    return rows.map(toEvent);
  }

  /**
   * Deletes one batch of an archive's rows (lowest ids first) and returns how many went. The rows
   * are exactly those `importantPage` exported: nothing newer than `maxId` is ever touched.
   */
  async deleteArchived(bound: ArchiveBound, batch: number): Promise<number> {
    const result: unknown = await this.events.query(
      `DELETE FROM audit_events WHERE id IN (
         SELECT id FROM audit_events
         WHERE ${IMPORTANT_AUDIT_SQL} AND created_at < $1 AND id <= $2
         ORDER BY id
         LIMIT $3
       ) RETURNING id`,
      [bound.before, bound.maxId, batch],
    );
    return deletedCount(result);
  }

  /** Newest first; keyset-based when a `cursor` is given, offset-based (with a total) otherwise. */
  async query(
    filter: AuditFilter,
    limit: number,
    offset: number,
    cursor?: string,
  ): Promise<AuditPage> {
    const query = this.events.createQueryBuilder("e");
    if (filter.action) query.andWhere("e.action = :action", { action: filter.action });
    if (filter.outcome) query.andWhere("e.outcome = :outcome", { outcome: filter.outcome });
    if (filter.walletId) query.andWhere("e.wallet_id = :walletId", { walletId: filter.walletId });
    if (filter.actorKeyId) {
      query.andWhere("e.actor_key_id = :actorKeyId", { actorKeyId: filter.actorKeyId });
    }
    if (filter.actorUserId) {
      query.andWhere("e.actor_user_id = :actorUserId", { actorUserId: filter.actorUserId });
    }
    if (filter.from) query.andWhere("e.created_at >= :from", { from: filter.from });
    if (filter.to) query.andWhere("e.created_at <= :to", { to: filter.to });

    let total: number | undefined;
    if (cursor === FIRST_PAGE_CURSOR) {
      // Cursor mode from the top: no keyset bound, no count.
    } else if (cursor !== undefined) {
      const position = decodeCursor(cursor);
      // The id column is a 32-bit serial; anything else would be a database error, not a 400.
      if (!/^\d{1,10}$/.test(position.id) || Number(position.id) > 2_147_483_647) {
        throw invalidCursor();
      }
      query.andWhere(
        "(e.created_at, e.id) < (CAST(:cursorAt AS timestamptz), CAST(:cursorId AS integer))",
        {
          cursorAt: position.createdAt,
          cursorId: position.id,
        },
      );
    } else {
      total = await query.getCount();
      query.skip(offset);
    }

    const rows = await query
      .orderBy("e.created_at", "DESC")
      .addOrderBy("e.id", "DESC")
      .take(limit + 1)
      .getMany();
    const events = rows.slice(0, limit).map(toEvent);
    const last = events[events.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return total === undefined ? { events, nextCursor } : { events, total, nextCursor };
  }
}

function toEvent(row: AuditEventEntity): AuditEvent {
  return {
    id: row.id,
    actorKeyId: row.actorKeyId,
    actorRole: row.actorRole,
    actorUserId: row.actorUserId,
    actorUsername: row.actorUsername,
    walletId: row.walletId,
    action: row.action,
    outcome: row.outcome,
    detail: parseDetail(row.detail),
    requestId: row.requestId,
    ip: row.ip,
    createdAt: row.createdAt,
  };
}

/** A row edited by hand is worth surfacing as raw text, not worth failing the whole page for. */
function parseDetail(detail: string | null): Record<string, unknown> | null {
  if (detail === null) return null;
  try {
    return JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return { raw: detail };
  }
}

/** node-postgres via TypeORM answers a raw `DELETE … RETURNING` as `[rows, affectedCount]`. */
function deletedCount(result: unknown): number {
  return (result as [unknown[], number])[1];
}
