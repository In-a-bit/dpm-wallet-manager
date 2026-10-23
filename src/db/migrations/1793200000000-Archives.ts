import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The archive record, and a stable insertion order for `operations`.
 *
 * An archive fixes its scope as "important rows before the cutoff, up to the highest id right
 * now", so a row written later is never in it even with an old `created_at`. `audit_events` has a
 * serial id for that; `operations` is keyed by uuid, so it gains `seq`. Adding a `bigserial`
 * column fills every existing row from the new sequence (Postgres evaluates the default per row),
 * so the column is complete as soon as this migration commits. Additive: an older image ignores
 * both the table and the column.
 *
 * At most one archive is not `done` at a time; the partial unique index enforces that against two
 * concurrent creates, not just the check the service makes first.
 */
export class Archives1793200000000 implements MigrationInterface {
  name = "Archives1793200000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "archives" (
         "id" uuid NOT NULL,
         "before" timestamptz NOT NULL,
         "scope" jsonb NOT NULL,
         "status" text NOT NULL,
         "sha256" text,
         "byte_size" bigint,
         "row_count" integer,
         "deleted" jsonb,
         "created_by_user_id" uuid,
         "created_by_key_id" uuid,
         "created_at" timestamptz NOT NULL,
         "downloaded_at" timestamptz,
         "deleted_at" timestamptz,
         CONSTRAINT "PK_archives" PRIMARY KEY ("id"),
         CONSTRAINT "archives_status" CHECK ("status" IN ('pending', 'downloaded', 'deleting', 'done'))
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "archives_one_open" ON "archives" ((true)) WHERE "status" <> 'done'`,
    );
    await queryRunner.query(`CREATE INDEX "archives_created_at" ON "archives" ("created_at")`);
    await queryRunner.query(`ALTER TABLE "operations" ADD COLUMN "seq" bigserial NOT NULL`);
    await queryRunner.query(`CREATE UNIQUE INDEX "operations_seq" ON "operations" ("seq")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "operations_seq"`);
    await queryRunner.query(`ALTER TABLE "operations" DROP COLUMN "seq"`);
    await queryRunner.query(`DROP INDEX "archives_created_at"`);
    await queryRunner.query(`DROP INDEX "archives_one_open"`);
    await queryRunner.query(`DROP TABLE "archives"`);
  }
}
