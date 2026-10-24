import path from "node:path";

import { runCli } from "./cli";
import { MANAGER_PORT, WALLET_PORT, writeInstallConfig } from "./config-writer";
import { fetchHttp } from "./http";
import { excerpt, Journal } from "./journal";
import { liveStatus } from "./live-status";
import { Client } from "pg";

import { applyServiceRoles, type Connect } from "./db-roles";
import { cleanupLegacy, runAll } from "./migrate";
import { SetupService } from "./setup-service";
import { SetupStateStore } from "./state";
import type { ProvisioningDeps, SetupHttp } from "./steps";
import { knownSecrets, supportReport } from "./support";
import type { DashboardModule, DashboardOptions } from "./tui/options";
import { SetupWorker } from "./worker";

/**
 * Entry point of the `setup` service in deploy/compose.yml. It runs from the dpm-wallet-manager
 * image but never loads the manager's configuration — producing that configuration is its job.
 *
 *   node dist/setup/main          the worker: runs provisioning once answers exist (default)
 *   node dist/setup/main setup    asks the questions and shows progress: the dashboard in a
 *                                 terminal, plain lines otherwise. SETUP_PLATFORM_URL and
 *                                 SETUP_BUILDER_KEY answer the first two questions (still checked)
 *   node dist/setup/main kit      print the backup kit again
 *   node dist/setup/main support  print the setup half of the support report
 *   node dist/setup/main migrate  bring the volumes up to this version's layout (idempotent)
 *   node dist/setup/main cleanup-legacy  empty the old single config volume, kept for rollback
 */
const env = (name: string, fallback: string): string => process.env[name] || fallback;

/** One volume per consumer (deploy/compose.yml); only setup mounts all of them. */
const WALLET_CONFIG_DIR = env("SETUP_WALLET_CONFIG_DIR", "/config-wallet");
const MANAGER_CONFIG_DIR = env("SETUP_MANAGER_CONFIG_DIR", "/config-manager");
const STATE_DIR = env("SETUP_STATE_DIR", "/state");
/** The single `config` volume of earlier versions; mounted read-only by setup (writable only in `dpm-custody cleanup-legacy` and upgrade runs). */
const LEGACY_CONFIG_DIR = env("SETUP_LEGACY_CONFIG_DIR", "/legacy-config");
const READY_TIMEOUT_MS = 5 * 60 * 1000;
/** About a minute of waiting for Postgres to accept connections. */
const POSTGRES_ATTEMPTS = 30;
/** Where the builder reaches the wallet manager (and its admin UI) from outside the stack. */
const MANAGER_PUBLIC_URL = env("SETUP_MANAGER_PUBLIC_URL", `http://localhost:${MANAGER_PORT}`);

async function main(): Promise<void> {
  // Volume maintenance needs neither the database password nor a store, so it comes first.
  const say = (line: string): void => void console.log(line);
  const dirs = {
    legacy: LEGACY_CONFIG_DIR,
    wallet: WALLET_CONFIG_DIR,
    manager: MANAGER_CONFIG_DIR,
    state: STATE_DIR,
  };
  switch (process.argv[2]) {
    case "migrate":
      return runAll(dirs, say, { connect: adminConnect() });
    case "cleanup-legacy":
      return cleanupLegacy(LEGACY_CONFIG_DIR, say);
  }

  const store = new SetupStateStore(STATE_DIR);
  const journal = new Journal(STATE_DIR, () => knownSecrets(store.load()));
  const deps = provisioningDeps(store, journal);
  const service = new SetupService(deps, journalledFetch(journal), `${MANAGER_PUBLIC_URL}/admin`);

  switch (process.argv[2] ?? "worker") {
    case "worker":
      return new SetupWorker(deps, journal).start();
    case "kit":
      return void process.stdout.write(service.backupKit());
    case "support": {
      const { checks } = await liveStatus(deps.http, store, deps);
      return void process.stdout.write(supportReport(store.load(), journal, checks));
    }
    case "setup":
    case "cli": {
      const presets = {
        platformUrl: process.env.SETUP_PLATFORM_URL,
        builderKey: process.env.SETUP_BUILDER_KEY,
      };
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return runCli(service, () => store.load(), presets, journal);
      }
      const options: DashboardOptions = {
        service,
        journal,
        presets,
        installSeconds: Number(process.env.SETUP_INSTALL_SECONDS) || undefined,
        managerPublicUrl: MANAGER_PUBLIC_URL,
      };
      // The dashboard is ESM (Ink needs top-level await), bundled apart; see package.json.
      const { runDashboard } = await importEsm<DashboardModule>(path.join(__dirname, "tui.mjs"));
      return runDashboard(options);
    }
    default:
      console.error(
        `Unknown command "${process.argv[2]}". Use setup, kit, support, migrate or cleanup-legacy.`,
      );
      process.exitCode = 2;
  }
}

/** A real `import()`: TypeScript turns the plain one into `require`, which cannot load ESM. */
// eslint-disable-next-line @typescript-eslint/no-implied-eval -- a fixed string, not input: the only way to keep a real import() through the CommonJS compile.
const importEsm = new Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;

function provisioningDeps(store: SetupStateStore, journal: Journal): ProvisioningDeps {
  const database = {
    user: env("POSTGRES_USER", "dpm"),
    password: requiredEnv("POSTGRES_PASSWORD"),
  };
  return {
    http: journalledHttp(journal),
    report: (event) => journal.append(event),
    store,
    provisionDbRoles: (secrets) =>
      applyServiceRoles(connectAs(database.user, database.password), secrets),
    writeConfig: (inputs) =>
      writeInstallConfig({ wallet: WALLET_CONFIG_DIR, manager: MANAGER_CONFIG_DIR }, inputs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    walletUrl: env("SETUP_WALLET_URL", `http://dpm-wallet:${WALLET_PORT}`),
    managerUrl: env("SETUP_MANAGER_URL", `http://dpm-wallet-manager:${MANAGER_PORT}`),
    database,
    readyTimeoutMs: READY_TIMEOUT_MS,
  };
}

/** Every request a step makes, with its outcome and timing, goes to the journal. */
function journalledHttp(journal: Journal): SetupHttp {
  return async (method, url, options) => {
    const started = Date.now();
    try {
      const result = await fetchHttp(method, url, options);
      journal.append({
        type: "http",
        method,
        url,
        ms: Date.now() - started,
        status: result.status,
        excerpt: result.status >= 400 ? excerpt(result.body) : undefined,
      });
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      journal.append({ type: "http", method, url, ms: Date.now() - started, error });
      throw err;
    }
  };
}

/** The same for the calls to the platform, which go through fetch directly. */
function journalledFetch(journal: Journal): typeof fetch {
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? "GET";
    const started = Date.now();
    try {
      const response = await fetch(input, init);
      const body = response.status >= 400 ? excerpt(await response.clone().text()) : undefined;
      journal.append({
        type: "http",
        method,
        url,
        ms: Date.now() - started,
        status: response.status,
        excerpt: body,
      });
      return response;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      journal.append({ type: "http", method, url, ms: Date.now() - started, error });
      throw err;
    }
  };
}

/**
 * Superuser access to Postgres, for the migrations: from the environment compose gives setup, or
 * `undefined` where there is no password (a migration that needs it then says so).
 */
function adminConnect(): Connect | undefined {
  const password = process.env.POSTGRES_PASSWORD;
  return password ? connectAs(env("POSTGRES_USER", "dpm"), password) : undefined;
}

/** Waits for the server to accept connections: setup can start before Postgres does. */
function connectAs(user: string, password: string): Connect {
  const host = env("SETUP_POSTGRES_HOST", "postgres");
  return async (database) => {
    for (let attempt = 1; ; attempt++) {
      const client = new Client({ host, port: 5432, user, password, database });
      try {
        await client.connect();
        return client;
      } catch (err) {
        await client.end().catch(() => undefined);
        if (attempt >= POSTGRES_ATTEMPTS) throw err;
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[setup] ${name} is required`);
    process.exit(1);
  }
  return value;
}

void main();
