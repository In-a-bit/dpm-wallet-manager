import type { MigrationInterface, QueryRunner } from "typeorm";

/** Additive: the oldest important record is worked out once per sample, not on every request. */
export class StorageSampleOldestImportant1793150000000 implements MigrationInterface {
  name = "StorageSampleOldestImportant1793150000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_samples" ADD "oldest_important_at" timestamptz`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "storage_samples" DROP COLUMN "oldest_important_at"`);
  }
}
