import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Scopes a stored idempotency key to the actor that used it: the primary key becomes
 * (actor, key). The existing rows are retry caches with no actor to attribute them to, so they
 * are dropped; at worst one in-flight retry signs again.
 */
export class IdempotencyKeyActor1793300000000 implements MigrationInterface {
  name = "IdempotencyKeyActor1793300000000";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "idempotency_keys"`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "PK_0afd83cbf08c9d12089a9bffc5e"`,
    );
    await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD "actor" text NOT NULL`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ADD CONSTRAINT "PK_idempotency_keys_actor_key" PRIMARY KEY ("actor", "key")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "idempotency_keys"`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "PK_idempotency_keys_actor_key"`,
    );
    await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP COLUMN "actor"`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ADD CONSTRAINT "PK_0afd83cbf08c9d12089a9bffc5e" PRIMARY KEY ("key")`,
    );
  }
}
