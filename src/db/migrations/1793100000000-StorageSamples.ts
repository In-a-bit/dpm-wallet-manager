import type { MigrationInterface, QueryRunner } from "typeorm";

/** One row every 15 minutes: disk, database sizes, growth and level. Trimmed after 30 days. */
export class StorageSamples1793100000000 implements MigrationInterface {
  name = "StorageSamples1793100000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "storage_samples" (
         "id" SERIAL NOT NULL,
         "at" timestamptz NOT NULL,
         "disk_total_bytes" bigint,
         "disk_free_bytes" bigint,
         "disk_used_percent" double precision,
         "wallet_db_bytes" bigint,
         "manager_db_bytes" bigint NOT NULL,
         "tables_json" text NOT NULL,
         "growth_bytes_per_day" double precision,
         "days_to_full" double precision,
         "level" text NOT NULL,
         CONSTRAINT "PK_storage_samples" PRIMARY KEY ("id")
       )`,
    );
    await queryRunner.query(`CREATE INDEX "storage_samples_at" ON "storage_samples" ("at")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "storage_samples_at"`);
    await queryRunner.query(`DROP TABLE "storage_samples"`);
  }
}
