import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The index an archive's operations export and delete walk: withdrawals in `(COALESCE(seq, 0),
 * id)` order. Built `CONCURRENTLY`, so writes to `operations` carry on while it builds, which is
 * why this migration runs outside a transaction (`transaction = false`; the data source runs
 * migrations in `each` mode for that). A build that failed half way leaves an invalid index, so
 * any leftover is dropped first.
 */
export class OperationsArchiveSeqIndex1793210000000 implements MigrationInterface {
  name = "OperationsArchiveSeqIndex1793210000000";
  transaction = false;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX CONCURRENTLY IF EXISTS "operations_archive_seq"`);
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "operations_archive_seq"
       ON "operations" ((COALESCE("seq", 0)), "id") WHERE "kind" = 'withdraw'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Plain DROP: a revert may run inside a transaction, where CONCURRENTLY is refused.
    await queryRunner.query(`DROP INDEX IF EXISTS "operations_archive_seq"`);
  }
}
