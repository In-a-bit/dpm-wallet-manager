import { join } from "node:path";

import { DataSource, type DataSourceOptions, type EntityManager } from "typeorm";

import { logInfo } from "../observability/log";

export type Db = DataSource;

/**
 * A transaction-scoped manager, or the pool-backed one. Repository methods that a caller may
 * want to run inside its own transaction take this instead of always using the pool: with a
 * connection pool, a statement issued against the pool while a transaction is open runs on a
 * *different* connection and is therefore outside that transaction.
 */
export type Executor = EntityManager;

/**
 * Shared by the service and the CLI's `data-source.ts`, so a migration authored from a
 * workstation cannot be generated against different options than the service runs with.
 *
 * `entities`/`migrations` are globbed off `__dirname` rather than imported and listed: a
 * relative glob resolves against the *caller's* working directory, but `__dirname` is this
 * file's own directory, so the pattern is right whether it is `ts-node`/`ts-jest` reading this
 * from `src/` or the image reading the compiled sibling from `dist/` — no list to keep in sync
 * with the folders as a new entity or migration is added.
 */
export function databaseOptions(connectionString: string): DataSourceOptions {
  return {
    type: "postgres",
    url: connectionString,
    entities: [join(__dirname, "entities", "*.entity.{ts,js}")],
    migrations: [join(__dirname, "migrations", "[0-9]*-*.{ts,js}")],
    // Never on. Applying a schema change is a deploy step an operator runs and can roll back,
    // not something a booting container infers from the entities in front of it.
    synchronize: false,
    migrationsRun: false,
  };
}

export async function openDatabase(connectionString: string): Promise<Db> {
  const db = new DataSource(databaseOptions(connectionString));
  await db.initialize();
  logInfo("db.opened");
  return db;
}

/** Drains the pool so the process can exit without waiting on idle connections. */
export async function closeDatabase(db: Db): Promise<void> {
  await db.destroy();
  logInfo("db.closed");
}
