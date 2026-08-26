import { logInfo } from "../observability/log";
import type { Db } from "./client";

/**
 * Idempotent: brings an older database up to the current schema after an image upgrade.
 *
 * Deliberately not called during boot. Applying a schema change is a deploy step an operator
 * runs and can roll back, not something a restarting container does on its own initiative —
 * and with more than one replica, concurrent boots would race to apply the same migration.
 */
export async function runMigrations(db: Db): Promise<void> {
  const applied = await db.runMigrations();
  logInfo("db.migrated", { applied: applied.length });
}
