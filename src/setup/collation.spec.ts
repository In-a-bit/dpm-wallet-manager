import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";

import { COLLATION_MARKER, reindexForNewCollation } from "./collation";
import type { Connect } from "./db-roles";
import { createTestDatabase } from "../testing/pg-test-db";

/** Against a real Postgres (docker compose up -d postgres, or TEST_DATABASE_URL). */
describe("reindexForNewCollation", () => {
  const adminUrl =
    process.env.TEST_DATABASE_URL?.trim() ||
    "postgres://postgres:postgres@localhost:5441/postgres?sslmode=disable";
  const withDb = (database: string): string => {
    const parsed = new URL(adminUrl);
    parsed.pathname = `/${database}`;
    return parsed.toString();
  };
  const connect: Connect = async (database) => {
    const client = new Client({ connectionString: withDb(database) });
    await client.connect();
    return client;
  };
  const nameOf = (url: string) => new URL(url).pathname.slice(1);
  const indexFile = async (database: string) => {
    const client = new Client({ connectionString: withDb(database) });
    await client.connect();
    const result = await client.query<{ f: string }>(
      `SELECT relfilenode::text AS f FROM pg_class WHERE relname = 'things_name_idx'`,
    );
    await client.end();
    return result.rows[0]?.f ?? "";
  };

  let db: Awaited<ReturnType<typeof createTestDatabase>>;
  let stateDir: string;

  beforeAll(async () => {
    db = await createTestDatabase();
    const client = await connect(nameOf(db.url));
    await client.query(`CREATE TABLE things (name text PRIMARY KEY)`);
    await client.query(`CREATE INDEX things_name_idx ON things (name)`);
    await client.query(`INSERT INTO things VALUES ('a'), ('B'), ('b')`);
    await client.end();
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-collation-"));
  });

  // Only the test database is touched: other specs' databases share this server.
  const run = (lines: string[] = []) =>
    reindexForNewCollation(connect, stateDir, (line) => lines.push(line), {
      databases: [nameOf(db.url)],
    });

  it("rebuilds the indexes when no rebuild is recorded, and records the C library it saw", async () => {
    const before = await indexFile(nameOf(db.url));
    await run();
    expect(await indexFile(nameOf(db.url))).not.toBe(before);
    expect(fs.readFileSync(path.join(stateDir, COLLATION_MARKER), "utf8")).toMatch(/^.+\|.*\n$/);
  });

  it("does nothing again while the server's C library is the one recorded", async () => {
    await run();
    const after = await indexFile(nameOf(db.url));
    const lines: string[] = [];
    await run(lines);
    expect(await indexFile(nameOf(db.url))).toBe(after);
    expect(lines.join("\n")).toContain("already match");
  });

  it("rebuilds again when the recorded C library differs, e.g. after a rollback and a new upgrade", async () => {
    await run();
    const first = await indexFile(nameOf(db.url));
    fs.writeFileSync(path.join(stateDir, COLLATION_MARKER), "x86_64-pc-linux-musl|\n");
    await run();
    expect(await indexFile(nameOf(db.url))).not.toBe(first);
  });

  it("leaves the marker unwritten when a rebuild fails, so the next start repeats it", async () => {
    const failing: Connect = async (database) => {
      const client = await connect(database);
      return {
        query: (sql: string) =>
          sql.startsWith("REINDEX") ? Promise.reject(new Error("boom")) : client.query(sql),
        end: () => client.end(),
      };
    };
    await expect(
      reindexForNewCollation(failing, stateDir, () => undefined, { databases: [nameOf(db.url)] }),
    ).rejects.toThrow("boom");
    expect(fs.existsSync(path.join(stateDir, COLLATION_MARKER))).toBe(false);
  });
});
