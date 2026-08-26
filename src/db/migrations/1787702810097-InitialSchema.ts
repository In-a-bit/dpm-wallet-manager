import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The whole schema. Generated from the entities, then extended by hand with the indexes an
 * entity cannot express: the `lower(...)` functional indexes and the partial unique indexes that
 * make "at most one master wallet" a database guarantee rather than a service convention.
 */
export class InitialSchema1787702810097 implements MigrationInterface {
  name = "InitialSchema1787702810097";

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "api_keys" ("id" uuid NOT NULL, "role" text NOT NULL, "name" text NOT NULL, "prefix" text NOT NULL, "hash" text NOT NULL, "secret_encrypted" text NOT NULL, "status" text NOT NULL, "expires_at" TIMESTAMP WITH TIME ZONE, "last_used_at" TIMESTAMP WITH TIME ZONE, "revoked_at" TIMESTAMP WITH TIME ZONE, "rotated_from_id" uuid, "created_by_key_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_5c8a79801b44bd27b79228e1dad" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "api_keys_role" ON "api_keys" ("role")`);
    await queryRunner.query(`CREATE UNIQUE INDEX "api_keys_prefix" ON "api_keys" ("prefix")`);
    await queryRunner.query(`CREATE INDEX "api_keys_status" ON "api_keys" ("status")`);

    await queryRunner.query(
      `CREATE TABLE "audit_events" ("id" SERIAL NOT NULL, "actor_key_id" uuid, "actor_role" text, "wallet_id" uuid, "action" text NOT NULL, "outcome" text NOT NULL, "detail" text, "request_id" text, "ip" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_910f64d901a5c3e9878f0d4a407" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "audit_events_actor_key_id" ON "audit_events" ("actor_key_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "audit_events_wallet_id" ON "audit_events" ("wallet_id")`,
    );
    await queryRunner.query(`CREATE INDEX "audit_events_action" ON "audit_events" ("action")`);
    await queryRunner.query(`CREATE INDEX "audit_events_outcome" ON "audit_events" ("outcome")`);
    await queryRunner.query(
      `CREATE INDEX "audit_events_created_at" ON "audit_events" ("created_at")`,
    );

    await queryRunner.query(
      `CREATE TABLE "operations" ("id" uuid NOT NULL, "wallet_id" uuid NOT NULL, "signer_wallet_id" uuid NOT NULL, "kind" text NOT NULL, "mode" text NOT NULL, "request_hash" text NOT NULL, "result_summary" text, "status" text NOT NULL, "api_key_id" uuid, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_7b62d84d6f9912b975987165856" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE INDEX "operations_wallet_id" ON "operations" ("wallet_id")`);
    await queryRunner.query(`CREATE INDEX "operations_kind" ON "operations" ("kind")`);
    await queryRunner.query(`CREATE INDEX "operations_created_at" ON "operations" ("created_at")`);

    await queryRunner.query(
      `CREATE TABLE "idempotency_keys" ("key" text NOT NULL, "request_hash" text NOT NULL, "response_json" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_0afd83cbf08c9d12089a9bffc5e" PRIMARY KEY ("key"))`,
    );

    await queryRunner.query(
      `CREATE TABLE "platform_settings" ("id" SERIAL NOT NULL, "key" text NOT NULL, "value" text NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_2934aeb70ec285196dcab4a2e96" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "platform_settings_key" ON "platform_settings" ("key")`,
    );

    await queryRunner.query(
      `CREATE TABLE "wallets" ("id" uuid NOT NULL, "ref" text NOT NULL, "kind" text NOT NULL, "external_id" text, "label" text, "status" text NOT NULL, "eoa_address" text, "proxy_address" text, "derivation_index" integer, "dpm_registered" boolean NOT NULL DEFAULT false, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL, "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_8402e5df5a30a229380e83e4f7e" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE UNIQUE INDEX "wallets_ref" ON "wallets" ("ref")`);
    await queryRunner.query(`CREATE INDEX "wallets_kind" ON "wallets" ("kind")`);
    await queryRunner.query(`CREATE INDEX "wallets_status" ON "wallets" ("status")`);

    // ── Hand-written from here down ──────────────────────────────────────────
    //
    // An index over an expression, and an index with a WHERE clause, cannot be declared on an
    // entity. These are the `synchronize: false` indexes named on `WalletEntity`: the schema
    // builder is told they exist so a later `migration:generate` leaves them alone instead of
    // treating them as drift and dropping them.

    // The funds policy asks "is this recipient one of ours?" on every withdraw. It matches
    // case-insensitively against both address columns, so both need a lower() index or the check
    // that guards every exit of funds becomes a sequential scan. Unique because dpm-wallet mints
    // one EOA per ref and derives one proxy per EOA — two rows sharing either would mean the
    // directory has lost track of which wallet owns an address.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_eoa_lower" ON "wallets" (lower("eoa_address")) WHERE "eoa_address" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_proxy_lower" ON "wallets" (lower("proxy_address")) WHERE "proxy_address" IS NOT NULL`,
    );

    // A caller's own id, unique case-insensitively so "Cust-1" and "cust-1" cannot become two
    // wallets for one customer. Partial, because most wallets have no external id.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_external_lower" ON "wallets" (lower("external_id")) WHERE "external_id" IS NOT NULL`,
    );

    // There is exactly one master wallet and one operations wallet, and that has to hold under
    // two concurrent provisioning calls. Enforced here rather than by a read-then-insert in the
    // service, which cannot be made safe without a lock.
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_one_master" ON "wallets" ("kind") WHERE "kind" = 'master'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "wallets_one_operations" ON "wallets" ("kind") WHERE "kind" = 'operations'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "public"."wallets_one_operations"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_one_master"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_external_lower"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_proxy_lower"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_eoa_lower"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_status"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_kind"`);
    await queryRunner.query(`DROP INDEX "public"."wallets_ref"`);
    await queryRunner.query(`DROP TABLE "wallets"`);
    await queryRunner.query(`DROP INDEX "public"."platform_settings_key"`);
    await queryRunner.query(`DROP TABLE "platform_settings"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP INDEX "public"."operations_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."operations_kind"`);
    await queryRunner.query(`DROP INDEX "public"."operations_wallet_id"`);
    await queryRunner.query(`DROP TABLE "operations"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_created_at"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_outcome"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_action"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_wallet_id"`);
    await queryRunner.query(`DROP INDEX "public"."audit_events_actor_key_id"`);
    await queryRunner.query(`DROP TABLE "audit_events"`);
    await queryRunner.query(`DROP INDEX "public"."api_keys_status"`);
    await queryRunner.query(`DROP INDEX "public"."api_keys_prefix"`);
    await queryRunner.query(`DROP INDEX "public"."api_keys_role"`);
    await queryRunner.query(`DROP TABLE "api_keys"`);
  }
}
