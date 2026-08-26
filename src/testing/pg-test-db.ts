import { randomBytes } from "node:crypto";

import { Pool } from "pg";

/**
 * The dev Postgres from docker-compose. Overridden by `TEST_DATABASE_URL`, matching how the
 * Go services in this workspace pick up a test database.
 */
const DEFAULT_TEST_DATABASE_URL =
  "postgres://postgres:postgres@localhost:5441/postgres?sslmode=disable";

/** A throwaway database, and the handle that removes it again. */
export type TestDatabase = {
  url: string;
  drop: () => Promise<void>;
};

/**
 * Creates an empty database for one test to own.
 *
 * A database rather than a schema, so migrations, the `to_regclass` schema probe and every
 * query run against exactly what production runs against. Jest gives each test file its own
 * worker, so anything shared would have the files racing to truncate each other's rows.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL?.trim() || DEFAULT_TEST_DATABASE_URL;
  const name = `dpmm_test_${randomBytes(8).toString("hex")}`;

  await withAdmin(adminUrl, (admin) => admin.query(`CREATE DATABASE "${name}"`));

  return {
    url: replaceDatabaseName(adminUrl, name),
    // FORCE so a pool the test left open cannot keep the database alive.
    drop: () =>
      withAdmin(adminUrl, (admin) => admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)),
  };
}

/**
 * Every statement here opens its own short-lived pool: `CREATE DATABASE` and `DROP DATABASE`
 * cannot run against the database being created or dropped, and holding an admin pool open for
 * the run would itself block a later drop.
 */
async function withAdmin(adminUrl: string, work: (admin: Pool) => Promise<unknown>): Promise<void> {
  const admin = new Pool({ connectionString: adminUrl });
  try {
    await work(admin);
  } catch (cause) {
    throw new Error(
      `Could not reach the test Postgres at ${redactPassword(adminUrl)}. ` +
        'Start it with "docker compose up -d postgres", or point TEST_DATABASE_URL at another ' +
        "instance.",
      { cause },
    );
  } finally {
    await admin.end();
  }
}

function replaceDatabaseName(url: string, name: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${name}`;
  return parsed.toString();
}

function redactPassword(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return url;
  }
}
