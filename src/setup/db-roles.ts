import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  databaseUrl,
  MANAGER_DATABASE,
  MANAGER_DB_ROLE,
  MANAGER_ENV_FILE,
  WALLET_DATABASE,
  WALLET_DB_ROLE,
  WALLET_ENV_FILE,
} from "./config-writer";
import type { InstallSecrets } from "./secrets";

/**
 * Least-privilege database roles. The Postgres superuser stays with `.env`, setup and Postgres
 * itself; each service connects as a role that owns its own database and nothing else, so a
 * compromised service cannot read the other's data or touch the server.
 */

/** A database connection, as much of `pg.Client` as this needs. */
export type SqlClient = { query(sql: string): Promise<unknown>; end(): Promise<void> };
/** Opens an administrator (superuser) connection to the named database. */
export type Connect = (database: string) => Promise<SqlClient>;

export type RoleSpec = {
  role: string;
  database: string;
  password: string;
  /** Built-in roles to be a member of, e.g. `pg_read_all_stats`. */
  memberOf?: string[];
};

/** What the manager's storage monitor needs to read the size of dpm-wallet's database. */
const MANAGER_MEMBER_OF = ["pg_read_all_stats"];

const NAME = /^[a-z][a-z0-9_]*$/;

/** The cluster-wide half: the role itself, its password and the ownership of its database. */
export function roleSql({ role, database, password, memberOf = [] }: RoleSpec): string[] {
  assertName(role);
  assertName(database);
  return [
    `DO $dpm$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role} LOGIN; END IF; END $dpm$`,
    // A SCRAM verifier computed here, not the password: a failing statement is logged by Postgres
    // with its text, and that must not be a password.
    `ALTER ROLE ${role} WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD ${quoteLiteral(scramVerifier(password))}`,
    `ALTER DATABASE ${database} OWNER TO ${role}`,
    // Only the owner (and the superuser) may connect: the other service's role is turned away.
    `REVOKE ALL ON DATABASE ${database} FROM PUBLIC`,
    ...memberOf.map((builtIn) => {
      assertName(builtIn);
      return `GRANT ${builtIn} TO ${role}`;
    }),
  ];
}

/**
 * The per-database half, run connected to it: hands the role everything the superuser created
 * there earlier (tables, sequences, enum types, functions, the public schema) so its migrations
 * can alter them. REASSIGN OWNED is deliberately not used: it would also move the ownership of
 * every database the old owner has, the other service's included.
 */
export function ownershipSql(role: string): string {
  assertName(role);
  return `DO $dpm$
DECLARE r record; target oid := (SELECT oid FROM pg_roles WHERE rolname = '${role}');
BEGIN
  FOR r IN SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relowner <> target AND c.relkind IN ('r','p','v','m','f')
  LOOP
    EXECUTE format('ALTER %s %I.%I OWNER TO ${role}',
      CASE r.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW' WHEN 'f' THEN 'FOREIGN TABLE' ELSE 'TABLE' END,
      'public', r.relname);
  END LOOP;
  -- A sequence owned by a column follows its table; only the free-standing ones are moved.
  FOR r IN SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = 'public' AND c.relowner <> target AND c.relkind = 'S'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d WHERE d.objid = c.oid AND d.classid = 'pg_class'::regclass AND d.deptype IN ('a','i'))
  LOOP
    EXECUTE format('ALTER SEQUENCE %I.%I OWNER TO ${role}', 'public', r.relname);
  END LOOP;
  FOR r IN SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
           WHERE n.nspname = 'public' AND t.typowner <> target AND t.typtype IN ('e','d')
  LOOP
    EXECUTE format('ALTER TYPE %I.%I OWNER TO ${role}', 'public', r.typname);
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure::text AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = 'public' AND p.proowner <> target AND p.prokind IN ('f','p')
  LOOP
    EXECUTE format('ALTER ROUTINE %s OWNER TO ${role}', r.signature);
  END LOOP;
  IF (SELECT nspowner FROM pg_namespace WHERE nspname = 'public') <> (SELECT oid FROM pg_roles WHERE rolname = 'pg_database_owner') THEN
    EXECUTE 'ALTER SCHEMA public OWNER TO ${role}';
  END IF;
END $dpm$`;
}

/** Creates or updates the role, hands it its database and everything already in it. Repeatable. */
export async function applyRole(connect: Connect, spec: RoleSpec): Promise<void> {
  const client = await connect(spec.database);
  try {
    for (const statement of roleSql(spec)) await client.query(statement);
    await client.query(ownershipSql(spec.role));
  } finally {
    await client.end();
  }
}

export async function applyServiceRoles(connect: Connect, secrets: InstallSecrets): Promise<void> {
  await applyRole(connect, {
    role: WALLET_DB_ROLE,
    database: WALLET_DATABASE,
    password: secrets.walletDbPassword,
  });
  await applyRole(connect, {
    role: MANAGER_DB_ROLE,
    database: MANAGER_DATABASE,
    password: secrets.managerDbPassword,
    memberOf: MANAGER_MEMBER_OF,
  });
}

/**
 * `setup migrate` for an install made before the roles existed, and a check on every start after:
 *  - a service whose env file connects as someone else gets its role, a fresh password and a
 *    rewritten DATABASE_URL;
 *  - a service already on its role has the role (re)applied with the password already in its
 *    env file, so a Postgres that lost the role (recreated data volume, restored backup) or
 *    objects the superuser created after a rollback are put right, without rotating anything.
 * Postgres is contacted only for a service that has a DATABASE_URL. `remember` is told every
 * service password so setup can mask it and not rotate it later.
 */
export async function convertExistingInstall(
  dirs: { wallet: string; manager: string },
  connect: Connect | undefined,
  say: (line: string) => void,
  remember: (service: "wallet" | "manager", password: string) => void = () => undefined,
): Promise<void> {
  const targets = [
    {
      service: "wallet" as const,
      file: path.join(dirs.wallet, WALLET_ENV_FILE),
      role: WALLET_DB_ROLE,
      database: WALLET_DATABASE,
      memberOf: [],
    },
    {
      service: "manager" as const,
      file: path.join(dirs.manager, MANAGER_ENV_FILE),
      role: MANAGER_DB_ROLE,
      database: MANAGER_DATABASE,
      memberOf: MANAGER_MEMBER_OF,
    },
  ];
  for (const target of targets) {
    if (!fs.existsSync(target.file)) continue;
    const text = fs.readFileSync(target.file, "utf8");
    const user = databaseUser(text);
    if (user === undefined) {
      say(`${target.role}: no DATABASE_URL to convert`);
      continue;
    }
    const { service, role, database, memberOf } = target;
    if (user === role) {
      const existing = databasePassword(text);
      if (!connect || existing === undefined) {
        say(`${role}: in use (not checked: no administrator credentials)`);
        continue;
      }
      await applyRole(connect, { role, database, password: existing, memberOf });
      remember(service, existing);
      say(`${role}: in use, checked`);
      continue;
    }
    if (!connect)
      throw new Error("Database administrator credentials are needed to create the service roles");
    const password = crypto.randomBytes(24).toString("hex");
    await applyRole(connect, { role, database, password, memberOf });
    // The file is rewritten only after the role exists; a crash in between just repeats this.
    const url = databaseUrl({ user: role, password }, database);
    const mode = fs.statSync(target.file).mode & 0o777;
    fs.writeFileSync(target.file, withDatabaseUrl(text, url), { mode });
    fs.chmodSync(target.file, mode);
    remember(service, password);
    say(`${role}: created, ${database} handed over, ${path.basename(target.file)} updated`);
  }
}

/** The user in an env file's DATABASE_URL, or undefined. */
export function databaseUser(envText: string): string | undefined {
  const match = /^DATABASE_URL='postgres(?:ql)?:\/\/([^:@/]*)[:@]/m.exec(envText);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

/** The password in an env file's DATABASE_URL, or undefined. */
export function databasePassword(envText: string): string | undefined {
  const match = /^DATABASE_URL='postgres(?:ql)?:\/\/[^:@/]*:([^@/]*)@/m.exec(envText);
  return match?.[1] === undefined ? undefined : decodeURIComponent(match[1]);
}

/**
 * A SCRAM-SHA-256 verifier for `password`, in the form Postgres stores: with it in ALTER ROLE the
 * server never sees (or logs) the password itself, and a client logs in with the password as usual.
 */
export function scramVerifier(password: string): string {
  const iterations = 4096;
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password.normalize("NFKC"), salt, iterations, 32, "sha256");
  const hmac = (key: Buffer, data: string) =>
    crypto.createHmac("sha256", key).update(data).digest();
  const storedKey = crypto.createHash("sha256").update(hmac(salted, "Client Key")).digest();
  const serverKey = hmac(salted, "Server Key");
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export function withDatabaseUrl(envText: string, url: string): string {
  if (/[']/.test(url)) throw new Error("DATABASE_URL contains a quote");
  return envText.replace(/^DATABASE_URL='.*'$/m, `DATABASE_URL='${url}'`);
}

function assertName(name: string): void {
  if (!NAME.test(name)) throw new Error(`Unsafe SQL name: ${name}`);
}

function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
