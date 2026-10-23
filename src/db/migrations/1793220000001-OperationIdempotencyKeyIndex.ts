import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The lookup a retried request makes: its idempotency key, kind and signer. Partial, since most
 * rows carry no key. Built `CONCURRENTLY`, so writes to `operations` carry on while it builds,
 * which is why this migration runs outside a transaction (`transaction = false`; the data source
 * runs migrations in `each` mode for that). A build that failed half way leaves an invalid index,
 * so any leftover is dropped first.
 */
export class OperationIdempotencyKeyIndex1793220000001 implements MigrationInterface {
  name = "OperationIdempotencyKeyIndex1793220000001";
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "operations_idempotency_key"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "operations_idempotency_key"
       ON "operations" ("idempotency_key", "kind", "signer_wallet_id")
       WHERE "idempotency_key" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Plain DROP: a revert may run inside a transaction, where CONCURRENTLY is refused.
    await queryRunner.query(`DROP INDEX IF EXISTS "operations_idempotency_key"`);
  }
}
