# Migrations stay additive

A rollback reverts the image tags and nothing else. The database keeps whatever the newer
release migrated, so the older service has to start on it. That holds only if migrations obey
this rule.

## The rule

- A release's migrations only add: tables, nullable or defaulted columns, and indexes.
- Dropping or renaming happens in a later release, once no supported version uses the old shape.
- Each service must start on a database migrated by the next release. TypeORM ignores migrations
  it does not know, and `assertSchemaPresent` only probes `wallets`. Both were verified (below).
- If the version-skew check fails on today's code, for example a startup check that rejects
  unknown migrations, fixing that startup check is in scope.
- A release that has to break the rule raises `MIN_UPGRADE_FROM` and says so in its notes. Its
  rollback is then the backup restore.

## What counts as additive

Additive: `CREATE TABLE`, `CREATE INDEX`, `ADD COLUMN` that is nullable or has a `DEFAULT`.

Adding a column with a volatile default (`bigserial`, `nextval(...)`, `gen_random_uuid()`) rewrites the whole table under an exclusive lock and needs free disk about the size of the table: add it nullable, then `ALTER COLUMN ... SET DEFAULT`, so only new rows get a value.

Not additive, so it waits for a later release (or raises `MIN_UPGRADE_FROM`): `DROP` of a table,
column or index the older version uses, renaming anything, `ADD COLUMN ... NOT NULL` without a
default, tightening a type or constraint, changing what an existing column means.

Removal takes two releases: release N stops using the old shape, release N+1 or later drops it,
once no version an operator may roll back to still reads it.

## Verified

Date: 2026-10-23. Node v22.23.2. Throwaway database on the local test Postgres, dropped afterwards.

1. Migrated a fresh database with the `ops-hardening` build (commit 4610f58) plus a temporary,
   uncommitted migration `ALTER TABLE "wallets" ADD COLUMN "skew_temp" text NULL`. Result:
   9 migrations recorded (through `OperationsArchiveSeqIndex1793210000000`), `wallets.skew_temp`
   present, `operations.seq` nullable with default `nextval('operations_seq_seq')`, and the
   `CONCURRENTLY`-built index `operations_archive_seq` valid and ready.
2. Ran `node dist/db/migrate-cli.js` built from `main` (commit 389faf0) against it. Result: exit 0,
   `db.migrated` with `applied: 0`. TypeORM ignores executed migrations it has no class for.
3. Inserted an `operations` row through `main`'s own `OperationRepository` (which knows nothing of
   `seq`). Result: the insert succeeded, `main` read it back, and the row got `seq = 1` from the
   column default. Running the `ops-hardening` build's migrate-cli again afterwards applied 0.
4. Started `node dist/main.js` built from `main` against it. Result: startup passed
   (`startup.ready`, then `listening`, `GET /v1/health` 200) with the dpm-wallet URL unreachable;
   it ran until stopped.

So a rollback to `main` needs no restore for an additive release.
