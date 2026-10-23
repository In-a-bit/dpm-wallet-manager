import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The caller's `Idempotency-Key` on the operation it produced, so a retried request can find its
 * own row again without merging with a different request that merely looks the same. Nullable and
 * without a default: a metadata-only change, no table rewrite. Rows from before it, and requests
 * sent without a key, carry NULL and are never merged.
 */
export class OperationIdempotencyKey1793220000000 implements MigrationInterface {
  name = "OperationIdempotencyKey1793220000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "operations" ADD COLUMN "idempotency_key" text`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "operations" DROP COLUMN "idempotency_key"`);
  }
}
