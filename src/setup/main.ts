import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { runCli } from "./cli";
import { MANAGER_PORT, WALLET_PORT, writeInstallConfig } from "./config-writer";
import { fetchHttp } from "./http";
import { liveStatus } from "./live-status";
import { createSetupServer } from "./server";
import { SetupService } from "./setup-service";
import { SetupStateStore } from "./state";
import type { ProvisioningDeps } from "./steps";

/**
 * Entry point of the `setup` service in deploy/compose.yml. It runs from the dpm-wallet-manager
 * image but never loads the manager's configuration — producing that configuration is its job.
 *
 *   node dist/setup/main          the setup page (default)
 *   node dist/setup/main cli      the same flow in the terminal
 *   node dist/setup/main kit      print the backup kit again
 */
const env = (name: string, fallback: string): string => process.env[name] || fallback;

const CONFIG_DIR = env("SETUP_CONFIG_DIR", "/config");
const LISTEN_PORT = Number(env("SETUP_PORT", "8480"));
const READY_TIMEOUT_MS = 5 * 60 * 1000;
const PIN_FILE = "setup-pin";
/** Where the builder reaches the wallet manager (and its admin UI) from outside the stack. */
const MANAGER_PUBLIC_URL = env("SETUP_MANAGER_PUBLIC_URL", `http://localhost:${MANAGER_PORT}`);

function main(): void {
  const store = new SetupStateStore(CONFIG_DIR);
  const deps = provisioningDeps(store);
  const service = new SetupService(deps, fetch, `${MANAGER_PUBLIC_URL}/admin`);

  const command = process.argv[2];
  if (command === "kit") return void process.stdout.write(service.backupKit());
  if (command === "cli") return void runCli(service, () => store.load());
  // Only the server clears a stale `running`: it is the container's main process, so when it
  // starts nothing else can be mid-run, whereas the terminal flow runs beside it.
  store.update((state) => {
    state.running = false;
  });
  startServer(service, deps);
}

function provisioningDeps(store: SetupStateStore): ProvisioningDeps {
  return {
    http: fetchHttp,
    store,
    writeConfig: (inputs) => writeInstallConfig(CONFIG_DIR, inputs),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    walletUrl: env("SETUP_WALLET_URL", `http://dpm-wallet:${WALLET_PORT}`),
    managerUrl: env("SETUP_MANAGER_URL", `http://dpm-wallet-manager:${MANAGER_PORT}`),
    database: { user: env("POSTGRES_USER", "dpm"), password: requiredEnv("POSTGRES_PASSWORD") },
    readyTimeoutMs: READY_TIMEOUT_MS,
  };
}

function startServer(service: SetupService, deps: ProvisioningDeps): void {
  const server = createSetupServer({
    service,
    pin: setupPin(),
    managerPublicUrl: MANAGER_PUBLIC_URL,
    liveStatus: () => liveStatus(deps.http, deps.store, deps),
  });
  server.listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log(`[setup] listening on :${LISTEN_PORT}`);
  });
  service.resume();
}

/**
 * The installer usually picks the PIN and passes it in. Otherwise one is generated once and kept
 * on the config volume, so a restart does not invalidate what the person was told.
 */
function setupPin(): string {
  if (process.env.SETUP_PIN) return process.env.SETUP_PIN;
  const file = path.join(CONFIG_DIR, PIN_FILE);
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, String(crypto.randomInt(100000, 1000000)), { mode: 0o600 });
  }
  const pin = fs.readFileSync(file, "utf8").trim();
  console.log(`[setup] setup PIN: ${pin}`);
  return pin;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[setup] ${name} is required`);
    process.exit(1);
  }
  return value;
}

main();
