import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Room on the operations log for relayer-api's transaction id, so a withdrawal this service
 * relayed itself can be looked up — and its status asked for — by the id the caller was given.
 */
export class RelayerTransactionId1792000000000 implements MigrationInterface {
  name = "RelayerTransactionId1792000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "operations" ADD "relayer_transaction_id" text`);
    await queryRunner.query(
      `CREATE INDEX "operations_relayer_transaction_id" ON "operations" ("relayer_transaction_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "operations_relayer_transaction_id"`);
    await queryRunner.query(`ALTER TABLE "operations" DROP COLUMN "relayer_transaction_id"`);
  }
}
