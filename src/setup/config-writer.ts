import fs from "node:fs";
import path from "node:path";

import type { InstallConfig } from "./platform-config";
import type { InstallSecrets } from "./secrets";
import type { SetupAnswers } from "./state";

/**
 * Files the compose wrappers read, each in its own service's volume (see deploy/compose.yml).
 * `ready` is written last in each: its presence means that service's env file is whole.
 */
export const WALLET_ENV_FILE = "dpm-wallet.env";
export const MANAGER_ENV_FILE = "dpm-wallet-manager.env";
export const READY_MARKER = "ready";

/** Each env file is owner-only: the service that reads it runs as the same user as setup. */
const OWNER_ONLY = 0o600;
const MARKER_MODE = 0o644;

/** The two volumes setup writes configuration into; each is mounted by one service only. */
export type ConfigDirs = { wallet: string; manager: string };

/** Where each service listens inside the compose network. Fixed: nothing outside reaches them. */
export const WALLET_PORT = 8090;
export const MANAGER_PORT = 3000;
const WALLET_HOST = "dpm-wallet";
const POSTGRES_HOST = "postgres";
export const WALLET_DATABASE = "dpm_wallet";
export const MANAGER_DATABASE = "dpm_wallet_manager";

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
    DATABASE_URL: databaseUrl(walletDbCredentials(secrets), WALLET_DATABASE),
    DATA_DIR: "/data",
    DPM_WALLET_API_KEY: secrets.walletApiKey,
    DPM_WALLET_ENCRYPTION_KEY: secrets.walletEncryptionKey,
    DPM_API_BASE_URL: platform.services.dpm_api,
    GAMMA_API_URL: platform.services.gamma_api,
    RELAYER_BASE_URL: platform.services.relayer_api,
    // Optional: a platform without a data-api leaves dpm-wallet without this variable.
    ...(platform.services.data_api ? { DATA_API_URL: platform.services.data_api } : {}),
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
    DATABASE_URL: databaseUrl(managerDbCredentials(secrets), MANAGER_DATABASE),
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

/** The services connect as their own roles, never as the database superuser. */
export const WALLET_DB_ROLE = "wallet_app";
export const MANAGER_DB_ROLE = "manager_app";

function walletDbCredentials(secrets: InstallSecrets): DatabaseCredentials {
  return { user: WALLET_DB_ROLE, password: secrets.walletDbPassword };
}

function managerDbCredentials(secrets: InstallSecrets): DatabaseCredentials {
  return { user: MANAGER_DB_ROLE, password: secrets.managerDbPassword };
}

export function writeInstallConfig(dirs: ConfigDirs, inputs: InstallInputs): void {
  writeFile(path.join(dirs.wallet, WALLET_ENV_FILE), renderEnvFile(walletEnv(inputs)), OWNER_ONLY);
  writeFile(
    path.join(dirs.manager, MANAGER_ENV_FILE),
    renderEnvFile(managerEnv(inputs)),
    OWNER_ONLY,
  );
  writeFile(path.join(dirs.wallet, READY_MARKER), "", MARKER_MODE);
  writeFile(path.join(dirs.manager, READY_MARKER), "", MARKER_MODE);
}

export function databaseUrl(credentials: DatabaseCredentials, database: string): string {
  const user = encodeURIComponent(credentials.user);
  const password = encodeURIComponent(credentials.password);
  return `postgres://${user}:${password}@${POSTGRES_HOST}:5432/${database}`;
}

function writeFile(file: string, content: string, mode: number): void {
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
}
