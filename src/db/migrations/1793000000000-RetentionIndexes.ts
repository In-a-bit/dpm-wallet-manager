import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Indexes the retention trimming and cursor paging need. `(created_at, id)` serves the batched
 * `ORDER BY created_at, id LIMIT n` deletes and keyset paging; the partial index makes
 * `findOrderByHash` (every cancel) an index lookup instead of a scan of every order.
 */
export class RetentionIndexes1793000000000 implements MigrationInterface {
  name = "RetentionIndexes1793000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "operations_created_at_id" ON "operations" ("created_at", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "operations_order_result_summary" ON "operations" ("result_summary") WHERE "kind" = 'order'`,
    );
    await queryRunner.query(
      `CREATE INDEX "audit_events_created_at_id" ON "audit_events" ("created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "audit_events_created_at_id"`);
    await queryRunner.query(`DROP INDEX "operations_order_result_summary"`);
    await queryRunner.query(`DROP INDEX "operations_created_at_id"`);
  }
}
