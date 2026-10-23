import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The archive record, and a stable insertion order for `operations`.
 *
 * An archive fixes its scope as "important rows before the cutoff, up to the highest id right
 * now", so a row written later is never in it even with an old `created_at`. `audit_events` has a
 * serial id for that; `operations` is keyed by uuid, so it gains `seq`.
 *
 * `seq` is added nullable with no default (a catalog-only change), and only then given a sequence
 * default, so only rows inserted from here on are numbered. A volatile default on `ADD COLUMN`
 * would rewrite the whole table under an exclusive lock. Rows left with a NULL `seq` all predate
 * every archive, so the archive bound reads them as `COALESCE(seq, 0)`. The index on it is built
 * `CONCURRENTLY` in the next migration. Additive: an older image ignores the table and the column.
 *
 * At most one archive is open (`pending`, `downloaded` or `deleting`) at a time; the partial
 * unique index enforces that against two concurrent creates, not just the service's own check.
 * `done` and `cancelled` are terminal and stay in the history.
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
         CONSTRAINT "archives_status" CHECK (
           "status" IN ('pending', 'downloaded', 'deleting', 'done', 'cancelled')
         )
       )`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "archives_one_open" ON "archives" ((true)) WHERE "status" IN ('pending', 'downloaded', 'deleting')`,
    );
    await queryRunner.query(`CREATE INDEX "archives_created_at" ON "archives" ("created_at")`);
    await queryRunner.query(`ALTER TABLE "operations" ADD COLUMN "seq" bigint`);
    await queryRunner.query(`CREATE SEQUENCE "operations_seq_seq" OWNED BY "operations"."seq"`);
    await queryRunner.query(
      `ALTER TABLE "operations" ALTER COLUMN "seq" SET DEFAULT nextval('operations_seq_seq')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping the column drops the sequence it owns.
    await queryRunner.query(`ALTER TABLE "operations" DROP COLUMN "seq"`);
    await queryRunner.query(`DROP INDEX "archives_created_at"`);
    await queryRunner.query(`DROP INDEX "archives_one_open"`);
    await queryRunner.query(`DROP TABLE "archives"`);
  }
}
