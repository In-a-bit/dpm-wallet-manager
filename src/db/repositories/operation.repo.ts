import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";

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
  apiKeyId: string | null;
  uiUserId: string | null;
  createdAt: string;
};

export type NewOperation = Omit<Operation, "createdAt"> & { createdAt: string };

export type OperationFilter = {
  walletId?: string;
  kind?: OperationKind;
  from?: string;
  to?: string;
};

export type OperationPage = { operations: Operation[]; total: number };

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

  async findById(id: string): Promise<Operation | undefined> {
    const row = await this.operations.findOneBy({ id });
    return row ?? undefined;
  }

  async query(filter: OperationFilter, limit: number, offset: number): Promise<OperationPage> {
    const query = this.operations.createQueryBuilder("o");
    if (filter.walletId) query.andWhere("o.wallet_id = :walletId", { walletId: filter.walletId });
    if (filter.kind) query.andWhere("o.kind = :kind", { kind: filter.kind });
    if (filter.from) query.andWhere("o.created_at >= :from", { from: filter.from });
    if (filter.to) query.andWhere("o.created_at <= :to", { to: filter.to });

    const [rows, total] = await query
      .orderBy("o.created_at", "DESC")
      .addOrderBy("o.id", "DESC")
      .take(limit)
      .skip(offset)
      .getManyAndCount();
    return { operations: rows, total };
  }
}
