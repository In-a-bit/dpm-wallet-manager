import { DataSource } from "typeorm";

import { databaseOptions } from "../db/client";
import { runMigrations } from "../db/migrate";
import { createTestDatabase, type TestDatabase } from "./pg-test-db";

export type DbFixture = {
  db: DataSource;
  close: () => Promise<void>;
};

/**
 * A migrated, empty database with a live DataSource over it, for the repository specs.
 *
 * Migrated rather than synchronised, so the specs run against the same DDL production runs
 * against — including the hand-written functional and partial indexes, which `synchronize` would
 * never create and which several of the guarantees under test depend on.
 */
export async function startDbFixture(): Promise<DbFixture> {
  const database: TestDatabase = await createTestDatabase();
  const db = new DataSource(databaseOptions(database.url));
  await db.initialize();
  await runMigrations(db);
  return {
    db,
    close: async () => {
      await db.destroy();
      await database.drop();
    },
  };
}
