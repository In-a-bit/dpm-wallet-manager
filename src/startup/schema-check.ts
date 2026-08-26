import type { Db } from "../db/client";

/** Any table from the first migration will do; this one is written on the very first request. */
const SCHEMA_PROBE_TABLE = "public.wallets";

/**
 * Migrating happens outside the service — the container's command, or an operator's — so an
 * unmigrated database is a deployment mistake rather than something to repair here. Saying so at
 * boot beats letting the first request fail on a missing table, which reads as a bug in the
 * service.
 */
export async function assertSchemaPresent(db: Db): Promise<void> {
  // to_regclass answers with null rather than raising when the table is absent, which is what
  // makes this a probe rather than something that has to be wrapped in a catch.
  const rows = await db.query<{ table: string | null }[]>(
    `SELECT to_regclass($1)::text AS "table"`,
    [SCHEMA_PROBE_TABLE],
  );
  if (rows[0]?.table) return;
  throw new Error(
    'The database has no schema. Run "npm run db:migrate" before starting the service — ' +
      "the image's own command does this, so reaching this means it was overridden.",
  );
}
