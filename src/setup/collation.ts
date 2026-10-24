import fs from "node:fs";
import path from "node:path";

import type { Connect } from "./db-roles";

/**
 * Text indexes depend on the C library's sort order. Alpine's Postgres (musl) has no real locale
 * support and sorts by code point; the Debian image (glibc) sorts by the locale's rules. An install
 * moved from one to the other keeps indexes built under the old order, and Postgres does not
 * notice: amcheck reports "item order invariant violated" and an equality lookup can miss rows that
 * are there. `REINDEX DATABASE` repairs them. (`ALTER DATABASE ... REFRESH COLLATION VERSION` is no
 * help here: a database made by musl records no version and Postgres refuses the refresh as an
 * "invalid collation version change", with or without the reindex.)
 *
 * So setup rebuilds every database's indexes when the server's C library, as it reports itself,
 * differs from the one the last rebuild saw. The key lives in the setup-state volume; it is written
 * only after every database succeeded, so an interrupted run is simply repeated.
 */
export const COLLATION_MARKER = ".collation-key";

type Rows = { rows?: Record<string, unknown>[] } | undefined;

export async function reindexForNewCollation(
  connect: Connect,
  stateDir: string,
  say: (line: string) => void,
  options: { databases?: string[] } = {},
): Promise<void> {
  const admin = await connect("postgres");
  let key: string | undefined;
  let names: string[];
  try {
    const info = (await admin.query(
      `SELECT substring(version() from 'on ([^,]+),') AS platform,
              pg_database_collation_actual_version(oid) AS actual
       FROM pg_database WHERE datname = current_database()`,
    )) as Rows;
    const row = info?.rows?.[0];
    if (row) key = `${asText(row.platform)}|${asText(row.actual)}`;
    const listed = (await admin.query(
      `SELECT datname FROM pg_database WHERE datallowconn ORDER BY datname`,
    )) as Rows;
    names = (listed?.rows ?? []).map((r) => String(r.datname));
  } finally {
    await admin.end();
  }
  if (!key) return say("could not read the server's collation version; not checked");

  const marker = path.join(stateDir, COLLATION_MARKER);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8").trim() === key) {
    return say("text indexes already match this server's C library");
  }
  const wanted = options.databases;
  for (const name of names.filter((n) => !wanted || wanted.includes(n))) {
    const client = await connect(name);
    try {
      await client.query(`REINDEX DATABASE ${quoteIdent(name)}`);
    } finally {
      await client.end();
    }
    say(`rebuilt the text indexes of ${name}`);
  }
  fs.writeFileSync(marker, `${key}\n`, { mode: 0o600 });
  say(`recorded ${key}`);
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}
