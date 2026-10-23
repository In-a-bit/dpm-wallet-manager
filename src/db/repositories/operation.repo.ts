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
import { OperationEntity, type OperationKind } from "../entities";

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
         WHERE (kind IN ('cancel', 'allowance', 'redeem', 'split', 'merge') AND created_at < $1)
            OR (kind = 'order' AND signer_wallet_id = wallet_id AND created_at < $1)
            OR (kind = 'order' AND signer_wallet_id <> wallet_id AND created_at < $2)
         ORDER BY created_at, id
         LIMIT $3
       ) RETURNING id`,
      [cutoff, routedCutoff, batch],
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
