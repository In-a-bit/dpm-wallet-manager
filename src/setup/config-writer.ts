import fs from "node:fs";
import path from "node:path";

import type { InstallConfig } from "./platform-config";
import type { InstallSecrets } from "./secrets";
import type { SetupAnswers } from "./state";

/** Files the compose wrappers read. `ready` is written last: its presence means both are whole. */
export const WALLET_ENV_FILE = "dpm-wallet.env";
export const MANAGER_ENV_FILE = "dpm-wallet-manager.env";
export const READY_MARKER = "ready";

/**
 * The service containers run as their own non-root users (different ones), so the files they
 * read are world-readable. They sit in a volume only this stack mounts, read-only everywhere but
 * setup; setup's own state file, which nobody else reads, stays owner-only (see state.ts).
 */
const SERVICE_READABLE = 0o644;

/** Where each service listens inside the compose network. Fixed: nothing outside reaches them. */
export const WALLET_PORT = 8090;
export const MANAGER_PORT = 3000;
const WALLET_HOST = "dpm-wallet";
const POSTGRES_HOST = "postgres";
const WALLET_DATABASE = "dpm_wallet";
const MANAGER_DATABASE = "dpm_wallet_manager";

export type DatabaseCredentials = { user: string; password: string };

export type InstallInputs = {
  answers: SetupAnswers;
  platform: InstallConfig;
  secrets: InstallSecrets;
  database: DatabaseCredentials;
  keyEnv: string;
};

export function walletEnv(inputs: InstallInputs): Record<string, string> {
  const { platform, secrets, answers } = inputs;
  return {
    PORT: String(WALLET_PORT),
    DATABASE_URL: databaseUrl(inputs.database, WALLET_DATABASE),
    DATA_DIR: "/data",
    DPM_WALLET_API_KEY: secrets.walletApiKey,
    DPM_WALLET_ENCRYPTION_KEY: secrets.walletEncryptionKey,
    DPM_API_BASE_URL: platform.services.dpm_api,
    GAMMA_API_URL: platform.services.gamma_api,
    RELAYER_BASE_URL: platform.services.relayer_api,
    // The builder key is the install's only platform credential: every service it calls
    // accepts it, so no platform-wide APP_API_KEY is written.
    RELAYER_BUILDER_API_KEY: answers.builderKey.trim(),
    CHAIN_ID: String(platform.chain_id),
    CONTRACT_CTF_EXCHANGE: platform.contracts.ctf_exchange,
    CONTRACT_PROXY_FACTORY: platform.contracts.proxy_factory,
    CONTRACT_PROXY_IMPL: platform.contracts.proxy_impl,
  };
}

export function managerEnv(inputs: InstallInputs): Record<string, string> {
  const { secrets, answers } = inputs;
  return {
    PORT: String(MANAGER_PORT),
    DATABASE_URL: databaseUrl(inputs.database, MANAGER_DATABASE),
    DPM_WALLET_MANAGER_MODE: answers.mode,
    DPM_WALLET_MANAGER_MASTER_KEY: secrets.managerMasterKey,
    DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY: secrets.adminKey,
    DPM_WALLET_MANAGER_KEY_ENV: inputs.keyEnv,
    DPM_WALLET_BASE_URL: `http://${WALLET_HOST}:${WALLET_PORT}`,
    DPM_WALLET_API_KEY: secrets.walletApiKey,
  };
}

/**
 * Renders a file both `sh` (the compose wrappers `.` it) and dotenv read the same way: every
 * value single-quoted. A value that could break out of its quotes is refused rather than escaped,
 * since none of ours legitimately contains one.
 */
export function renderEnvFile(values: Record<string, string>): string {
  const lines = Object.entries(values).map(([name, value]) => {
    if (/['\n\r]/.test(value)) throw new Error(`${name} contains a quote or line break`);
    return `${name}='${value}'`;
  });
  return `# Written by dpm-wallet-manager setup. Do not edit by hand.\n${lines.join("\n")}\n`;
}

export function writeInstallConfig(configDir: string, inputs: InstallInputs): void {
  writeServiceFile(path.join(configDir, WALLET_ENV_FILE), renderEnvFile(walletEnv(inputs)));
  writeServiceFile(path.join(configDir, MANAGER_ENV_FILE), renderEnvFile(managerEnv(inputs)));
  writeServiceFile(path.join(configDir, READY_MARKER), "");
}

function databaseUrl(credentials: DatabaseCredentials, database: string): string {
  const user = encodeURIComponent(credentials.user);
  const password = encodeURIComponent(credentials.password);
  return `postgres://${user}:${password}@${POSTGRES_HOST}:5432/${database}`;
}

function writeServiceFile(file: string, content: string): void {
  fs.writeFileSync(file, content, { mode: SERVICE_READABLE });
  fs.chmodSync(file, SERVICE_READABLE);
}
