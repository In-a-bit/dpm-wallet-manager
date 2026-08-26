import { LOG_LEVELS, type LogLevel } from "../config";

/**
 * One JSON object per line on stdout, matching the dpm-wallet / prediction-gateway convention.
 *
 * The level is read from the environment directly rather than injected, because logging has to
 * work before the config provider exists — a config parse failure is itself something to log.
 */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.trim() as LogLevel | undefined;
  return raw && (LOG_LEVELS as readonly string[]).includes(raw) ? raw : "info";
}

/**
 * Field names whose values never reach the log, whatever they hold. API keys are the point:
 * one accidental `logInfo("key.created", { key })` would put a live credential in whatever
 * aggregates stdout, where it cannot be recalled.
 */
const REDACTED_KEYS = new Set([
  "key",
  "apikey",
  "api_key",
  "secret",
  "secretencrypted",
  "secret_encrypted",
  "password",
  "pepper",
  "masterkey",
  "master_key",
  "encryptionkey",
  "encryption_key",
  "authorization",
  "x-api-key",
  "hash",
  "privatekey",
  "private_key",
]);

/** Long hex — signatures, calldata — is truncated rather than dropped: the prefix aids support. */
const TRUNCATE_OVER = 130;

export function logDebug(event: string, fields?: Record<string, unknown>): void {
  write("debug", event, fields);
}
export function logInfo(event: string, fields?: Record<string, unknown>): void {
  write("info", event, fields);
}
export function logWarn(event: string, fields?: Record<string, unknown>): void {
  write("warn", event, fields);
}
export function logError(event: string, fields?: Record<string, unknown>): void {
  write("error", event, fields);
}

function write(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[currentLevel()]) return;
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  });
  if (level === "error" || level === "warn") process.stderr.write(`${line}\n`);
  else process.stdout.write(`${line}\n`);
}

/** Exported for the tests that pin the redaction rules. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (value instanceof Error) {
    return { name: value.name, message: value.message, ...errorExtras(value) };
  }
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        REDACTED_KEYS.has(key.toLowerCase()) ? "[redacted]" : redact(entry, depth + 1),
      ]),
    );
  }
  if (typeof value === "string" && value.length > TRUNCATE_OVER) {
    return `${value.slice(0, 20)}…(${value.length})`;
  }
  return value;
}

function errorExtras(error: Error): Record<string, unknown> {
  const code = (error as { code?: unknown }).code;
  return code === undefined ? {} : { code };
}
