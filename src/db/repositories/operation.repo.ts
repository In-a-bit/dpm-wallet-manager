import { Inject, Injectable } from "@nestjs/common";
import { In, IsNull, type Repository } from "typeorm";

import {
  decodeCursor,
  encodeCursor,
  FIRST_PAGE_CURSOR,
  invalidCursor,
} from "../../common/dto/cursor";
import { DB } from "../../tokens";
import type { Db } from "../client";
import { OperationEntity, type OperationKind } from "../entities";

/** Kinds retention trims on a schedule. `withdraw` is the one kind it never touches. */
export const ROUTINE_OPERATION_KINDS = [
  "order",
  "cancel",
  "allowance",
  "redeem",
  "split",
  "merge",
] as const satisfies readonly OperationKind[];

/** SQL over `operations` (unaliased) selecting the important rows only an archive removes. */
export const IMPORTANT_OPERATION_SQL = `(kind = 'withdraw')`;

/**
 * An archive's fixed scope over this table. Ids here are uuids, so the bound is `seq`: a sequence
 * number every row inserted since the archive migration gets, which a row written after the
 * scope was fixed always exceeds, whatever `created_at` it carries. Rows from before the
 * migration have a NULL `seq` and read as 0: they predate every scope.
 */
export type OperationArchiveBound = { before: string; maxSeq: number };

/** Where an export page resumes: after this `(COALESCE(seq, 0), id)`. */
export type OperationArchivePosition = { seq: number; id: string };

/** Before every row: no `seq` is below 0 and no uuid below the nil one. */
export const ARCHIVE_START: OperationArchivePosition = {
  seq: -1,
  id: "00000000-0000-0000-0000-000000000000",
};

/** The archive bound over `operations`, with `$1` the cutoff and `$2` the `seq` ceiling. */
const ARCHIVED_OPERATION_SQL = `${IMPORTANT_OPERATION_SQL} AND created_at < $1 AND COALESCE(seq, 0) <= $2`;

export type Operation = {
  id: string;
  walletId: string;
  signerWalletId: string;
  kind: OperationKind;
  mode: string;
  requestHash: string;
  resultSummary: string | null;
  status: string;
  relayerTransactionId: string | null;
  idempotencyKey: string | null;
  apiKeyId: string | null;
  uiUserId: string | null;
  createdAt: string;
};

export type NewOperation = Omit<Operation, "createdAt" | "relayerTransactionId"> & {
  createdAt: string;
};

export type OperationFilter = {
  walletId?: string;
  kind?: OperationKind;
  from?: string;
  to?: string;
};

export type OperationPage = {
  operations: Operation[];
  /** Absent in cursor mode, where counting the whole table is the cost being avoided. */
  total?: number;
  nextCursor: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class OperationRepository {
  private readonly operations: Repository<OperationEntity>;

  constructor(@Inject(DB) db: Db) {
    this.operations = db.getRepository(OperationEntity);
  }

  async insert(operation: NewOperation): Promise<void> {
    await this.operations.insert(operation);
  }

  /**
   * Inserts unless this is the same request retried under the same idempotency key, and returns
   * the id of whichever row stands. A retry gets the original signature back, so the same key,
   * kind, signer, request and actor means the same action, not a second one. Without a key nothing is
   * merged: two requests that look alike are still two requests, each with its own actor.
   */
  async insertOrGet(operation: NewOperation): Promise<string> {
    if (operation.idempotencyKey) {
      const keyIds = operation.apiKeyId ? await this.rotationFamily(operation.apiKeyId) : undefined;
      const existing = await this.operations.findOne({
        where: {
          idempotencyKey: operation.idempotencyKey,
          kind: operation.kind,
          signerWalletId: operation.signerWalletId,
          requestHash: operation.requestHash,
          // The same actor's retry (a rotated key is the same actor): another caller reusing a key
          // is a different action.
          apiKeyId: keyIds ? In(keyIds) : IsNull(),
          uiUserId: operation.uiUserId ?? IsNull(),
        },
        order: { createdAt: "ASC" },
      });
      if (existing) return existing.id;
    }
    await this.operations.insert(operation);
    return operation.id;
  }

  /** Every key of the rotation chain `keyId` belongs to: its root and everything rotated from it. */
  private async rotationFamily(keyId: string): Promise<string[]> {
    const rows: { id: string }[] = await this.operations.query(
      `WITH RECURSIVE up AS (
         SELECT id, rotated_from_id FROM api_keys WHERE id = $1
         UNION ALL
         SELECT k.id, k.rotated_from_id FROM api_keys k JOIN up ON k.id = up.rotated_from_id
       ), down AS (
         SELECT id FROM up u WHERE NOT EXISTS (SELECT 1 FROM api_keys p WHERE p.id = u.rotated_from_id)
         UNION ALL
         SELECT k.id FROM api_keys k JOIN down ON k.rotated_from_id = down.id
       )
       SELECT id FROM down`,
      [keyId],
    );
    return rows.length > 0 ? rows.map((row) => row.id) : [keyId];
  }

  /**
   * The order this hash came from, so a cancel can be signed by whoever signed the order. In
   * shared mode that is not the wallet the caller names.
   */
  async findOrderByHash(orderHash: string): Promise<Operation | undefined> {
    const row = await this.operations.findOne({
      where: { kind: "order", resultSummary: orderHash },
      order: { createdAt: "DESC" },
    });
    return row ?? undefined;
  }

  async setRelayerTransactionId(id: string, relayerTransactionId: string): Promise<void> {
    await this.operations.update({ id }, { relayerTransactionId });
  }

  async findByRelayerTransactionId(relayerTransactionId: string): Promise<Operation | undefined> {
    const row = await this.operations.findOneBy({ relayerTransactionId });
    return row ?? undefined;
  }

  async findById(id: string): Promise<Operation | undefined> {
    const row = await this.operations.findOneBy({ id });
    return row ?? undefined;
  }

  /**
   * Deletes one batch of routine rows and returns how many went. Routine kinds are everything but
   * `withdraw`; an `order` whose signer differs from the named wallet (a routed order) is held to
   * the longer `routedCutoff`. The caller loops until a batch comes back short.
   */
  async purgeRoutine(cutoff: string, routedCutoff: string, batch: number): Promise<number> {
    const result: unknown = await this.operations.query(
      `DELETE FROM operations WHERE id IN (
         SELECT id FROM operations
         WHERE (kind IN (${ROUTINE_OPERATION_KINDS.filter((kind) => kind !== "order")
           .map((kind) => `'${kind}'`)
           .join(", ")}) AND created_at < $1)
            OR (kind = 'order' AND signer_wallet_id = wallet_id AND created_at < $1)
            OR (kind = 'order' AND signer_wallet_id <> wallet_id AND created_at < $2)
         ORDER BY created_at, id
         LIMIT $3
       ) RETURNING id`,
      [cutoff, routedCutoff, batch],
    );
    return deletedCount(result);
  }

  /** The highest `seq` (0 when none) and the row count of the important rows before `before`. */
  async importantScope(before: string): Promise<{ maxSeq: number; rows: number }> {
    const rows: { maxSeq: string; rows: number }[] = await this.operations.query(
      `SELECT COALESCE(MAX(seq), 0)::text AS "maxSeq", COUNT(*)::int AS rows FROM operations
       WHERE ${IMPORTANT_OPERATION_SQL} AND created_at < $1`,
      [before],
    );
    return { maxSeq: Number(rows[0]?.maxSeq ?? 0), rows: rows[0]?.rows ?? 0 };
  }

  /** How many rows the archive bound covers right now. */
  async countArchived(bound: OperationArchiveBound): Promise<number> {
    const rows: { rows: number }[] = await this.operations.query(
      `SELECT COUNT(*)::int AS rows FROM operations WHERE ${ARCHIVED_OPERATION_SQL}`,
      [bound.before, bound.maxSeq],
    );
    return rows[0]?.rows ?? 0;
  }

  /**
   * One page of an archive's rows in `(COALESCE(seq, 0), id)` order after `after`, each with its
   * position, so the next page resumes exactly where this one stopped.
   */
  async importantPage(
    bound: OperationArchiveBound,
    after: OperationArchivePosition,
    limit: number,
  ): Promise<{ position: OperationArchivePosition; operation: Operation }[]> {
    const rows: (Omit<Operation, "createdAt"> & { createdAt: Date; seq: string })[] =
      await this.operations.query(
        `SELECT id, wallet_id AS "walletId", signer_wallet_id AS "signerWalletId", kind, mode,
                request_hash AS "requestHash", result_summary AS "resultSummary", status,
                relayer_transaction_id AS "relayerTransactionId", api_key_id AS "apiKeyId",
                ui_user_id AS "uiUserId", created_at AS "createdAt",
                COALESCE(seq, 0)::text AS seq
         FROM operations
         WHERE ${ARCHIVED_OPERATION_SQL}
           AND (COALESCE(seq, 0), id) > ($3::bigint, $4::uuid)
         ORDER BY COALESCE(seq, 0), id
         LIMIT $5`,
        [bound.before, bound.maxSeq, after.seq, after.id, limit],
      );
    return rows.map(({ seq, createdAt, ...rest }) => ({
      position: { seq: Number(seq), id: rest.id },
      operation: { ...rest, createdAt: createdAt.toISOString() },
    }));
  }

  /**
   * Deletes one batch of an archive's rows (in export order) and returns how many went: exactly
   * the rows `importantPage` exported, never one written after the scope was fixed.
   */
  async deleteArchived(bound: OperationArchiveBound, batch: number): Promise<number> {
    const result: unknown = await this.operations.query(
      `DELETE FROM operations WHERE id IN (
         SELECT id FROM operations
         WHERE ${ARCHIVED_OPERATION_SQL}
         ORDER BY COALESCE(seq, 0), id
         LIMIT $3
       ) RETURNING id`,
      [bound.before, bound.maxSeq, batch],
    );
    return deletedCount(result);
  }

  /**
   * Newest first. With a `cursor` the page is keyset-based — `(created_at, id)` strictly below
   * the cursor — so rows arriving meanwhile cannot shift it; without one it is offset-based and
   * carries a total. One extra row is fetched to know whether a next page exists.
   */
  async query(
    filter: OperationFilter,
    limit: number,
    offset: number,
    cursor?: string,
  ): Promise<OperationPage> {
    const query = this.operations.createQueryBuilder("o");
    if (filter.walletId) query.andWhere("o.wallet_id = :walletId", { walletId: filter.walletId });
    if (filter.kind) query.andWhere("o.kind = :kind", { kind: filter.kind });
    if (filter.from) query.andWhere("o.created_at >= :from", { from: filter.from });
    if (filter.to) query.andWhere("o.created_at <= :to", { to: filter.to });

    let total: number | undefined;
    if (cursor === FIRST_PAGE_CURSOR) {
      // Cursor mode from the top: no keyset bound, no count.
    } else if (cursor !== undefined) {
      const position = decodeCursor(cursor);
      if (!UUID.test(position.id)) throw invalidCursor();
      query.andWhere(
        "(o.created_at, o.id) < (CAST(:cursorAt AS timestamptz), CAST(:cursorId AS uuid))",
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
      .orderBy("o.created_at", "DESC")
      .addOrderBy("o.id", "DESC")
      .take(limit + 1)
      .getMany();
    const operations = rows.slice(0, limit);
    const last = operations[operations.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return total === undefined ? { operations, nextCursor } : { operations, total, nextCursor };
  }
}

/** node-postgres via TypeORM answers a raw `DELETE … RETURNING` as `[rows, affectedCount]`. */
function deletedCount(result: unknown): number {
  return (result as [unknown[], number])[1];
}
