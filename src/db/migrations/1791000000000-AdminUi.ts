import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The admin UI: its users and their sessions, and room in the audit trail, the operations log and
 * the key table to record which person — not only which key — acted.
 *
 * Usernames are unique case-insensitively through a functional index, which an entity cannot
 * express, the same way the initial schema handles wallet addresses.
 */
export class AdminUi1791000000000 implements MigrationInterface {
  name = "AdminUi1791000000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "ui_users" ("id" uuid NOT NULL, "username" text NOT NULL, "password_hash" text NOT NULL, "role" text NOT NULL, "status" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_login_at" TIMESTAMP WITH TIME ZONE, "created_by_key_id" uuid, "created_by_user_id" uuid, CONSTRAINT "PK_ui_users" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ui_users_username_lower" ON "ui_users" (lower("username"))`,
    );

    await queryRunner.query(
      `CREATE TABLE "ui_sessions" ("id" uuid NOT NULL, "token_hash" text NOT NULL, "user_id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "last_seen_at" TIMESTAMP WITH TIME ZONE NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL, "ip" text, "user_agent" text, CONSTRAINT "PK_ui_sessions" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ui_sessions_token_hash" ON "ui_sessions" ("token_hash")`,
    );
    await queryRunner.query(`CREATE INDEX "ui_sessions_user_id" ON "ui_sessions" ("user_id")`);
    await queryRunner.query(
      `CREATE INDEX "ui_sessions_expires_at" ON "ui_sessions" ("expires_at")`,
    );

    await queryRunner.query(`ALTER TABLE "audit_events" ADD "actor_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "audit_events" ADD "actor_username" text`);
    await queryRunner.query(
      `CREATE INDEX "audit_events_actor_user_id" ON "audit_events" ("actor_user_id")`,
    );
    await queryRunner.query(`ALTER TABLE "operations" ADD "ui_user_id" uuid`);
    await queryRunner.query(`ALTER TABLE "api_keys" ADD "created_by_user_id" uuid`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "api_keys" DROP COLUMN "created_by_user_id"`);
    await queryRunner.query(`ALTER TABLE "operations" DROP COLUMN "ui_user_id"`);
    await queryRunner.query(`DROP INDEX "audit_events_actor_user_id"`);
    await queryRunner.query(`ALTER TABLE "audit_events" DROP COLUMN "actor_username"`);
    await queryRunner.query(`ALTER TABLE "audit_events" DROP COLUMN "actor_user_id"`);
    await queryRunner.query(`DROP TABLE "ui_sessions"`);
    await queryRunner.query(`DROP TABLE "ui_users"`);
  }
}
