import "dotenv/config";

import { loadConfig } from "../config";
import { logError } from "../observability/log";
import { closeDatabase, openDatabase } from "./client";
import { runMigrations } from "./migrate";

/**
 * The migration step, as its own process.
 *
 * The TypeORM CLI covers this during development, but the runtime image drops the dev
 * dependencies — and with them ts-node, which the CLI needs to read the TypeScript data
 * source. This reads the same `DATABASE_URL` the service does, so the operator cannot
 * migrate one database and start against another.
 */
async function main(): Promise<void> {
  const { databaseUrl } = loadConfig();
  const db = await openDatabase(databaseUrl);
  try {
    await runMigrations(db);
  } finally {
    await closeDatabase(db);
  }
}

main().catch((err: unknown) => {
  logError("db.migrate_failed", { err });
  process.exit(1);
});
