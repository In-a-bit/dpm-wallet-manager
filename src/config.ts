/**
 * Environment to typed config, parsed once at boot. Every required value is asserted here so a
 * misconfigured container fails before it binds a port rather than on the first request that
 * happens to need the missing field.
 *
 * Parsed by hand rather than through a schema library, matching dpm-wallet: the surface is small
 * and the error messages are better when each field says what it wants.
 */

/** Custody mode. Burned into `platform_settings` on first boot and immutable thereafter. */
export const PLATFORM_MODES = ["segregated", "shared"] as const;
export type PlatformMode = (typeof PLATFORM_MODES)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type Config = {
  port: number;
  logLevel: LogLevel;
  /** libpq connection string for the Postgres database holding every table. */
  databaseUrl: string;
  /**
   * The mode this container expects. Compared against the burned-in value at boot; a
   * disagreement aborts startup rather than picking a winner.
   */
  mode: PlatformMode;
  /**
   * 32 bytes of hex. HKDF-expanded into the API-key HMAC pepper and the AES-256-GCM key that
   * encrypts the revealable copy of each key. Losing it makes every stored key unverifiable and
   * unrevealable, so it belongs in the operator's secret store.
   */
  masterKey: string;
  /** Adopted as the first admin key when the table is empty. Optional; otherwise one is minted. */
  bootstrapAdminKey: string | undefined;
  /** Labels minted keys (`dpmm_live_…` / `dpmm_test_…`) so a staging key is obvious on sight. */
  keyEnvironment: string;
  dpmWallet: {
    baseUrl: string;
    /** This service's key *into* dpm-wallet, sent as X-API-Key. */
    apiKey: string;
    timeoutMs: number;
  };
  /** Prepended to every ref sent upstream, so one dpm-wallet can host more than one install. */
  walletRefPrefix: string;
  /** Exact origins the backoffice UI may call from. Empty disables CORS entirely. */
  corsOrigins: string[];
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: parsePort(env.PORT),
    logLevel: parseEnum("LOG_LEVEL", env.LOG_LEVEL, LOG_LEVELS, "info"),
    databaseUrl: required("DATABASE_URL", env.DATABASE_URL),
    mode: parseEnum(
      "DPM_WALLET_MANAGER_MODE",
      env.DPM_WALLET_MANAGER_MODE,
      PLATFORM_MODES,
      undefined,
    ),
    masterKey: requiredHex("DPM_WALLET_MANAGER_MASTER_KEY", env.DPM_WALLET_MANAGER_MASTER_KEY, 32),
    bootstrapAdminKey: optional(env.DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY),
    keyEnvironment: parseKeyEnvironment(env.DPM_WALLET_MANAGER_KEY_ENV),
    dpmWallet: {
      baseUrl: trimSlash(required("DPM_WALLET_BASE_URL", env.DPM_WALLET_BASE_URL)),
      apiKey: required("DPM_WALLET_API_KEY", env.DPM_WALLET_API_KEY),
      timeoutMs: parsePositiveInt("DPM_WALLET_TIMEOUT_MS", env.DPM_WALLET_TIMEOUT_MS, 15_000),
    },
    walletRefPrefix: optional(env.WALLET_REF_PREFIX) ?? "mgr:",
    corsOrigins: parseList(env.CORS_ORIGINS),
  };
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function required(name: string, value: string | undefined): string {
  const trimmed = optional(value);
  if (!trimmed) throw new Error(`${name} is required`);
  return trimmed;
}

function requiredHex(name: string, value: string | undefined, bytes: number): string {
  const raw = required(name, value);
  if (!new RegExp(`^[0-9a-fA-F]{${bytes * 2}}$`).test(raw)) {
    throw new Error(`${name} must be ${bytes} bytes of hex (${bytes * 2} characters)`);
  }
  return raw.toLowerCase();
}

function trimSlash(value: string): string {
  return value.replace(/\/$/, "");
}

function parseList(raw: string | undefined): string[] {
  return (optional(raw) ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function parsePort(raw: string | undefined): number {
  const port = Number(optional(raw) ?? "3000");
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

function parsePositiveInt(name: string, raw: string | undefined, fallback: number): number {
  const value = Number(optional(raw) ?? String(fallback));
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** Free-form but constrained, because it becomes part of every key string. */
function parseKeyEnvironment(raw: string | undefined): string {
  const value = optional(raw) ?? "live";
  if (!/^[a-z0-9]{2,12}$/.test(value)) {
    throw new Error("DPM_WALLET_MANAGER_KEY_ENV must be 2-12 lowercase alphanumeric characters");
  }
  return value;
}

/** A `fallback` of `undefined` makes the variable required. */
function parseEnum<T extends string>(
  name: string,
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T | undefined,
): T {
  const value = optional(raw);
  if (!value) {
    if (fallback === undefined) throw new Error(`${name} must be one of ${allowed.join(", ")}`);
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`${name} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}
