import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

import { decodeCursor, encodeCursor, invalidCursor } from "../../common/dto/cursor";
import { DB } from "../../tokens";
import type { Db } from "../client";
import { AuditEventEntity } from "../entities";

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
         WHERE outcome = 'success' AND created_at < $1
           AND action IN ('sign.order', 'sign.cancel', 'meta.allowance', 'meta.redeem',
                          'meta.split', 'meta.merge')
         ORDER BY created_at, id
         LIMIT $2
       ) RETURNING id`,
      [cutoff, batch],
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
    if (cursor !== undefined) {
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
