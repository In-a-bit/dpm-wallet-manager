import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Client } from "pg";

import { MANAGER_ENV_FILE, WALLET_ENV_FILE } from "./config-writer";
import {
  applyRole,
  convertExistingInstall,
  databasePassword,
  databaseUser,
  scramVerifier,
  ownershipSql,
  roleSql,
  withDatabaseUrl,
  type Connect,
} from "./db-roles";
import { runAll } from "./migrate";
import { generateInstallSecrets, withDbPasswords } from "./secrets";
import { SetupStateStore } from "./state";
import { knownSecrets } from "./support";
import { StorageSampleRepository } from "../db/repositories/storage-sample.repo";
import { startHarness } from "../testing/harness";
import { createTestDatabase } from "../testing/pg-test-db";

describe("role SQL", () => {
  const spec = { role: "wallet_app", database: "dpm_wallet", password: "pa'ss" };

  it("creates a login role without any privilege, owns the database, closes it to others", () => {
    const sql = roleSql(spec).join("\n");
    expect(sql).toContain("CREATE ROLE wallet_app LOGIN");
    expect(sql).toContain("NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS");
    // A SCRAM verifier, never the password: a failed statement is logged by Postgres with its text.
    expect(sql).toMatch(
      /PASSWORD 'SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+'/,
    );
    expect(sql).not.toContain("pa'ss");
    expect(sql).not.toContain("pa''ss");
    expect(sql).toContain("ALTER DATABASE dpm_wallet OWNER TO wallet_app");
    expect(sql).toContain("REVOKE ALL ON DATABASE dpm_wallet FROM PUBLIC");
  });

  it("lets only the roles asked for read all stats", () => {
    expect(roleSql(spec).join("\n")).not.toContain("pg_read_all_stats");
    expect(roleSql({ ...spec, memberOf: ["pg_read_all_stats"] })).toContain(
      "GRANT pg_read_all_stats TO wallet_app",
    );
  });

  it("never reassigns by owner, which would take the other database along", () => {
    expect(ownershipSql("wallet_app")).not.toMatch(/REASSIGN/i);
  });

  it("refuses a name that is not a plain identifier", () => {
    expect(() => roleSql({ ...spec, role: "x; DROP DATABASE y" })).toThrow(/Unsafe/);
    expect(() => ownershipSql("Bad-Name")).toThrow(/Unsafe/);
  });
});

describe("scramVerifier", () => {
  it("has the shape and the keys Postgres stores for SCRAM-SHA-256", () => {
    const verifier = scramVerifier("secret");
    const match = /^SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)$/.exec(verifier);
    expect(match).not.toBeNull();
    expect(scramVerifier("secret")).not.toBe(verifier); // fresh salt each time
  });
});

describe("env file rewriting", () => {
  const text = "A='1'\nDATABASE_URL='postgres://dpm:p%40ss@postgres:5432/dpm_wallet'\nB='2'\n";

  it("reads the user and swaps only the URL", () => {
    expect(databaseUser(text)).toBe("dpm");
    const out = withDatabaseUrl(text, "postgres://wallet_app:x@postgres:5432/dpm_wallet");
    expect(databaseUser(out)).toBe("wallet_app");
    expect(out).toContain("A='1'");
    expect(out).toContain("B='2'");
  });
});

describe("convertExistingInstall", () => {
  const dirs = () => ({
    wallet: fs.mkdtempSync(path.join(os.tmpdir(), "dpm-roles-")),
    manager: fs.mkdtempSync(path.join(os.tmpdir(), "dpm-roles-")),
  });
  const seed = (d: { wallet: string; manager: string }) => {
    for (const [dir, file, db] of [
      [d.wallet, WALLET_ENV_FILE, "dpm_wallet"],
      [d.manager, MANAGER_ENV_FILE, "dpm_wallet_manager"],
    ] as const) {
      fs.writeFileSync(
        path.join(dir, file),
        `DATABASE_URL='postgres://dpm:super@postgres:5432/${db}'\nOTHER='kept'\n`,
        { mode: 0o600 },
      );
    }
  };
  const recorder = () => {
    const statements: string[] = [];
    const connect: Connect = async () => ({
      query: async (sql) => void statements.push(sql),
      end: async () => undefined,
    });
    return { connect, statements };
  };

  it("moves each service onto its role once, keeping the file mode, and is idempotent", async () => {
    const d = dirs();
    seed(d);
    const first = recorder();
    await convertExistingInstall(d, first.connect, () => undefined);

    const wallet = fs.readFileSync(path.join(d.wallet, WALLET_ENV_FILE), "utf8");
    const manager = fs.readFileSync(path.join(d.manager, MANAGER_ENV_FILE), "utf8");
    expect(databaseUser(wallet)).toBe("wallet_app");
    expect(databaseUser(manager)).toBe("manager_app");
    expect(wallet).toContain("OTHER='kept'");
    expect(wallet).not.toContain("super");
    expect(fs.statSync(path.join(d.wallet, WALLET_ENV_FILE)).mode & 0o777).toBe(0o600);
    expect(first.statements.some((sql) => sql.includes("OWNER TO manager_app"))).toBe(true);

    // The manager's account may measure dpm-wallet's database (storage monitoring does).
    expect(
      first.statements.some((sql) => sql.includes("GRANT pg_read_all_stats TO manager_app")),
    ).toBe(true);
    expect(
      first.statements.some((sql) => sql.includes("GRANT pg_read_all_stats TO wallet_app")),
    ).toBe(false);
  });

  it("re-applies a role the env file already names, with the password it has, rotating nothing", async () => {
    const d = dirs();
    seed(d);
    await convertExistingInstall(d, recorder().connect, () => undefined);
    const before = fs.readFileSync(path.join(d.wallet, WALLET_ENV_FILE), "utf8");
    const remembered: string[] = [];
    const again = recorder();
    await convertExistingInstall(
      d,
      again.connect,
      () => undefined,
      (service, password) => remembered.push(`${service}:${password}`),
    );
    // Repaired against Postgres every time (the role may be gone), the file untouched.
    expect(again.statements.some((sql) => sql.includes("CREATE ROLE wallet_app"))).toBe(true);
    expect(fs.readFileSync(path.join(d.wallet, WALLET_ENV_FILE), "utf8")).toBe(before);
    expect(remembered).toContain(`wallet:${databasePassword(before)}`);
  });

  it("reads a hand-edited password with a bare % as written instead of throwing", () => {
    const text = (password: string) =>
      `DATABASE_URL='postgres://dpm%:${password}@postgres:5432/db'\n`;
    expect(databasePassword(text("50%off"))).toBe("50%off");
    expect(databaseUser(text("x"))).toBe("dpm%");
    // A properly encoded one still decodes.
    expect(databasePassword(text("p%40ss"))).toBe("p@ss");
  });

  it("does not contact Postgres for a fresh install with no env files, or fail without access", async () => {
    await convertExistingInstall(dirs(), undefined, () => undefined);
    const d = dirs();
    seed(d);
    await expect(convertExistingInstall(d, undefined, () => undefined)).rejects.toThrow(
      /administrator credentials/,
    );
  });

  it("saves the generated passwords in setup's secrets, when setup has any", async () => {
    const d = { ...dirs(), legacy: fs.mkdtempSync(path.join(os.tmpdir(), "dpm-roles-")) };
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-roles-"));
    fs.writeFileSync(
      path.join(d.legacy, WALLET_ENV_FILE),
      "DATABASE_URL='postgres://dpm:super@postgres:5432/dpm_wallet'\n",
    );
    const store = new SetupStateStore(state);
    store.update((s) => {
      s.secrets = generateInstallSecrets("dev");
      delete (s.secrets as Partial<typeof s.secrets>).walletDbPassword;
    });
    await runAll({ ...d, state }, () => undefined, { connect: recorder().connect });
    const written = databasePassword(fs.readFileSync(path.join(d.wallet, WALLET_ENV_FILE), "utf8"));
    expect(store.load().secrets?.walletDbPassword).toBe(written);
    // So it is masked like every other secret, and a later write-config does not rotate it.
    expect(knownSecrets(store.load())).toContain(written);
    expect(withDbPasswords(store.load().secrets as never).walletDbPassword).toBe(written);
  });

  it("runs as a setup migrate step, after the volumes are split", async () => {
    const d = { ...dirs(), legacy: fs.mkdtempSync(path.join(os.tmpdir(), "dpm-roles-")) };
    const state = fs.mkdtempSync(path.join(os.tmpdir(), "dpm-roles-"));
    fs.writeFileSync(
      path.join(d.legacy, WALLET_ENV_FILE),
      "DATABASE_URL='postgres://dpm:super@postgres:5432/dpm_wallet'\n",
    );
    const { connect, statements } = recorder();
    await runAll({ ...d, state }, () => undefined, { connect });
    expect(databaseUser(fs.readFileSync(path.join(d.wallet, WALLET_ENV_FILE), "utf8"))).toBe(
      "wallet_app",
    );
    expect(statements.length).toBeGreaterThan(0);
    // The old volume is untouched, so a rollback still has the superuser it expects.
    expect(databaseUser(fs.readFileSync(path.join(d.legacy, WALLET_ENV_FILE), "utf8"))).toBe("dpm");
  });
});

/** Against a real Postgres (docker compose up -d postgres, or TEST_DATABASE_URL). */
describe("service roles in Postgres", () => {
  const adminUrl =
    process.env.TEST_DATABASE_URL?.trim() ||
    "postgres://postgres:postgres@localhost:5441/postgres?sslmode=disable";
  const withDb = (url: string, database: string, user?: string, password?: string): string => {
    const parsed = new URL(url);
    parsed.pathname = `/${database}`;
    if (user) {
      parsed.username = user;
      parsed.password = password ?? "";
    }
    return parsed.toString();
  };
  const open = async (url: string): Promise<Client> => {
    const client = new Client({ connectionString: url });
    await client.connect();
    return client;
  };
  const suffix = randomBytes(4).toString("hex");
  const roleA = `t_wallet_${suffix}`;
  const roleB = `t_manager_${suffix}`;
  const passwordA = randomBytes(12).toString("hex");
  const passwordB = randomBytes(12).toString("hex");
  let dbA: Awaited<ReturnType<typeof createTestDatabase>>;
  let dbB: Awaited<ReturnType<typeof createTestDatabase>>;
  const nameOf = (url: string) => new URL(url).pathname.slice(1);
  const connect: Connect = (database) => open(withDb(adminUrl, database));

  beforeAll(async () => {
    dbA = await createTestDatabase();
    dbB = await createTestDatabase();
    const admin = await open(dbA.url);
    await admin.query(`CREATE TYPE mood AS ENUM ('a','b')`);
    await admin.query(`CREATE TABLE things (id serial PRIMARY KEY, m mood)`);
    await admin.query(`CREATE SEQUENCE free_seq`);
    await admin.query(`CREATE FUNCTION answer() RETURNS int LANGUAGE sql AS 'SELECT 42'`);
    await admin.end();
    const adminB = await open(dbB.url);
    await adminB.query(`CREATE TABLE secrets (v text)`);
    await adminB.end();
  });

  afterAll(async () => {
    await dbA.drop();
    await dbB.drop();
    const admin = await open(adminUrl);
    await admin.query(`DROP ROLE IF EXISTS ${roleA}`);
    await admin.query(`DROP ROLE IF EXISTS ${roleB}`);
    await admin.end();
  });

  it("hands over everything, can be repeated, and keeps the roles apart", async () => {
    const a = { role: roleA, database: nameOf(dbA.url), password: passwordA };
    const b = { role: roleB, database: nameOf(dbB.url), password: passwordB };
    await applyRole(connect, a);
    await applyRole(connect, a);
    await applyRole(connect, b);

    const admin = await open(adminUrl);
    const owners = async (database: string) =>
      (
        await (async () => {
          const c = await open(withDb(adminUrl, database));
          const r = await c.query(
            `SELECT 'table' AS k, pg_get_userbyid(relowner) AS o FROM pg_class WHERE relname = 'things'
             UNION ALL SELECT 'seq', pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'free_seq'
             UNION ALL SELECT 'owned_seq', pg_get_userbyid(relowner) FROM pg_class WHERE relname = 'things_id_seq'
             UNION ALL SELECT 'type', pg_get_userbyid(typowner) FROM pg_type WHERE typname = 'mood'
             UNION ALL SELECT 'func', pg_get_userbyid(proowner) FROM pg_proc WHERE proname = 'answer'`,
          );
          await c.end();
          return r.rows as { k: string; o: string }[];
        })()
      ).map((row) => `${row.k}:${row.o}`);
    expect((await owners(a.database)).sort()).toEqual(
      ["table", "seq", "owned_seq", "type", "func"].map((k) => `${k}:${roleA}`).sort(),
    );

    const flags = await admin.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolcanlogin FROM pg_roles WHERE rolname = $1`,
      [roleA],
    );
    expect(flags.rows[0]).toEqual({
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolcanlogin: true,
    });
    const dbOwners = await admin.query(
      `SELECT datname, pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = ANY($1)`,
      [[a.database, b.database]],
    );
    const ownerOf = Object.fromEntries(dbOwners.rows.map((r) => [r.datname, r.owner]));
    // Two roles, two databases: converting one must not take the other along.
    expect(ownerOf).toEqual({ [a.database]: roleA, [b.database]: roleB });
    await admin.end();

    // Its migrations can alter and create objects, as the service's boot does.
    const asA = await open(withDb(adminUrl, a.database, roleA, passwordA));
    await asA.query(`ALTER TABLE things ADD COLUMN extra int`);
    await asA.query(`CREATE TABLE made_later (id int)`);
    await asA.end();

    // But it cannot reach the other service's database, nor create roles or databases.
    await expect(open(withDb(adminUrl, b.database, roleA, passwordA))).rejects.toThrow(
      /permission denied|not allowed/i,
    );
    const again = await open(withDb(adminUrl, a.database, roleA, passwordA));
    await expect(again.query(`CREATE ROLE sneaky`)).rejects.toThrow(/permission denied/);
    await expect(again.query(`CREATE DATABASE sneaky`)).rejects.toThrow(/permission denied/);
    await again.end();
  });

  it("lets the manager boot, migrate and write as its role, on a database the superuser filled", async () => {
    const db = await createTestDatabase();
    const role = `t_boot_${suffix}`;
    const password = randomBytes(12).toString("hex");
    try {
      // The superuser's install: migrations applied and rows written as it, as before the roles.
      const before = await startHarness({ DATABASE_URL: db.url });
      await before.post("/v1/wallets", { body: { externalId: "before-roles" } });
      await before.stop();

      await applyRole(connect, { role, database: nameOf(db.url), password });

      // Booted as the role: every migration is a no-op or runs as the owner, and writes work.
      const after = await startHarness({
        DATABASE_URL: withDb(adminUrl, nameOf(db.url), role, password),
      });
      try {
        const created = await after.post("/v1/wallets", { body: { externalId: "after-roles" } });
        expect(created.status).toBe(201);
        expect((await after.wallets.list({ q: "before-roles" }, 10, 0)).total).toBe(1);
      } finally {
        await after.close();
      }
    } finally {
      await db.drop();
      const admin = await open(adminUrl);
      await admin.query(`DROP ROLE IF EXISTS ${role}`);
      await admin.end();
    }
  });

  it("lets the manager's role measure both databases, so storage sampling keeps working", async () => {
    // The wallet database is looked up by its real name, so this needs the name to be free here.
    const admin = await open(adminUrl);
    const taken = await admin.query(`SELECT 1 FROM pg_database WHERE datname = 'dpm_wallet'`);
    if (taken.rowCount) {
      await admin.end();
      // Someone's real database: never take it over. Say so, so a skipped check is not a pass.
      console.warn(
        "SKIPPED: a database named dpm_wallet exists here, so the storage-sampling grant check did not run",
      );
      return;
    }
    const walletRole = `t_ws_${suffix}`;
    const managerRole = `t_ms_${suffix}`;
    const managerDb = await createTestDatabase();
    const walletPassword = randomBytes(12).toString("hex");
    const managerPassword = randomBytes(12).toString("hex");
    await admin.query(`CREATE DATABASE dpm_wallet`);
    try {
      await applyRole(connect, {
        role: walletRole,
        database: "dpm_wallet",
        password: walletPassword,
      });
      await applyRole(connect, {
        role: managerRole,
        database: nameOf(managerDb.url),
        password: managerPassword,
        memberOf: ["pg_read_all_stats"],
      });
      const harness = await startHarness({
        DATABASE_URL: withDb(adminUrl, nameOf(managerDb.url), managerRole, managerPassword),
      });
      try {
        const sizes = await harness.app.get(StorageSampleRepository).databaseSizes();
        expect(sizes.manager).toBeGreaterThan(0);
        expect(sizes.wallet).toBeGreaterThan(0);
      } finally {
        await harness.close();
      }

      // Without the grant the wallet size is unreadable; the sample still goes ahead with null.
      await admin.query(`REVOKE pg_read_all_stats FROM ${managerRole}`);
      const limited = await startHarness({
        DATABASE_URL: withDb(adminUrl, nameOf(managerDb.url), managerRole, managerPassword),
      });
      try {
        const sizes = await limited.app.get(StorageSampleRepository).databaseSizes();
        expect(sizes.manager).toBeGreaterThan(0);
        expect(sizes.wallet).toBeNull();
      } finally {
        await limited.close();
      }
    } finally {
      await managerDb.drop();
      await admin.query(`DROP DATABASE IF EXISTS dpm_wallet WITH (FORCE)`);
      await admin.query(`DROP ROLE IF EXISTS ${walletRole}`);
      await admin.query(`DROP ROLE IF EXISTS ${managerRole}`);
      await admin.end();
    }
  });
});
