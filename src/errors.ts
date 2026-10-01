/**
 * The complete set of error codes a caller can receive, with the HTTP status each maps to.
 *
 * Codes are part of the API contract — the backoffice UI and any trading backend branch on them
 * (`WALLET_NOT_READY` is retried, `EXTERNAL_TRANSFER_FORBIDDEN` never is) — so neither the string
 * nor the status may change without a version bump. The envelope shape matches dpm-wallet's, so a
 * caller sitting in front of both services sees one contract.
 */
export const ERROR_STATUS = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  VALIDATION_FAILED: 400,
  WALLET_NOT_FOUND: 404,
  WALLET_NOT_READY: 409,
  WALLET_DISABLED: 409,
  WALLET_NOT_REGISTERED: 409,
  EXTERNAL_ID_TAKEN: 409,
  MASTER_WALLET_EXISTS: 409,
  OPERATIONS_WALLET_REQUIRED: 409,
  OPERATIONS_WALLET_EXISTS: 409,
  EXTERNAL_TRANSFER_FORBIDDEN: 403,
  MASTER_ALLOWANCE_FORBIDDEN: 403,
  MASTER_WALLET_CANNOT_TRADE: 403,
  API_KEY_NOT_FOUND: 404,
  API_KEY_REVOKED: 409,
  LAST_ADMIN_KEY: 409,
  UI_USER_NOT_FOUND: 404,
  USERNAME_TAKEN: 409,
  LAST_OWNER: 409,
  CSRF_HEADER_REQUIRED: 403,
  RATE_LIMITED: 429,
  IDEMPOTENCY_CONFLICT: 409,
  UPSTREAM_UNAVAILABLE: 502,
  UPSTREAM_REJECTED: 502,
  INTERNAL_ERROR: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_STATUS;

/**
 * One sentence per code, for the OpenAPI document.
 *
 * Kept beside the status map rather than written into each `@ApiErrors(...)` call so a code has
 * exactly one description wherever it appears, and adding a code to `ERROR_STATUS` without
 * explaining it is a compile error.
 */
export const ERROR_DESCRIPTIONS: Record<ErrorCode, string> = {
  UNAUTHORIZED:
    "No valid credential: the X-API-Key header is missing, malformed, revoked or expired, and " +
    "there is no signed-in admin UI session.",
  FORBIDDEN: "The caller authenticated but its role does not reach this endpoint.",
  VALIDATION_FAILED:
    "The body, query or path failed validation. `details.issues` lists each offending path.",
  WALLET_NOT_FOUND: "No wallet with that id or external id.",
  WALLET_NOT_READY:
    "The wallet row exists but dpm-wallet has not confirmed an address for it. Retry after " +
    "POST /v1/wallets/{id}/reconcile.",
  WALLET_DISABLED: "The wallet has been disabled and may not sign.",
  WALLET_NOT_REGISTERED:
    "The wallet's EOA is not registered with the DPM platform, so no relay payload is " +
    "available. Register it first — see POST /v1/wallets/{id}/dpm-attestation.",
  EXTERNAL_ID_TAKEN: "Another wallet already uses that external id, case-insensitively.",
  MASTER_WALLET_EXISTS: "A master wallet already exists; there can only be one.",
  OPERATIONS_WALLET_REQUIRED:
    "This install runs in shared mode, which needs an operations wallet before it can route " +
    "an order. Create one with POST /v1/platform/operations-wallet.",
  OPERATIONS_WALLET_EXISTS: "An operations wallet already exists; there can only be one.",
  EXTERNAL_TRANSFER_FORBIDDEN:
    "Funds may leave the platform only from the master wallet and only with an admin key.",
  MASTER_ALLOWANCE_FORBIDDEN:
    "The master wallet is deliberately left without an allowance, so it cannot be spent by the " +
    "exchange or the proxy.",
  MASTER_WALLET_CANNOT_TRADE:
    "The master wallet holds funds for withdrawal only and does not trade.",
  API_KEY_NOT_FOUND: "No API key with that id.",
  API_KEY_REVOKED: "That key has been revoked and cannot be rotated.",
  LAST_ADMIN_KEY:
    "That is the last usable admin key; revoking it would lock this install out of its own " +
    "administration. Create another first.",
  UI_USER_NOT_FOUND: "No admin UI user with that id.",
  USERNAME_TAKEN: "Another admin UI user already has that username, case-insensitively.",
  LAST_OWNER:
    "That is the last active owner; disabling or demoting it would leave nobody able to manage " +
    "this install from the admin UI. Make another user an owner first.",
  CSRF_HEADER_REQUIRED:
    "A request authenticated by the admin UI session cookie must carry " +
    "`X-Requested-With: dpmm-admin` to change anything.",
  RATE_LIMITED: "Too many requests for this resource in the current window.",
  IDEMPOTENCY_CONFLICT: "This Idempotency-Key was already used with a different request body.",
  UPSTREAM_UNAVAILABLE:
    "dpm-wallet could not be reached, or answered with a server error. Safe to retry.",
  UPSTREAM_REJECTED:
    "dpm-wallet refused the request. `details.upstream` carries its own error code.",
  INTERNAL_ERROR: "An unexpected failure. The message is withheld.",
};

export type ErrorEnvelope = {
  error: { code: ErrorCode; message: string; details?: Record<string, unknown> };
};

/**
 * An error carrying a code the client is expected to act on. Anything thrown that is not a
 * ManagerError is treated as a bug and reported as INTERNAL_ERROR with its message withheld, so
 * an unexpected failure cannot leak internals through the envelope.
 */
export class ManagerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(
    code: ErrorCode,
    message: string,
    options?: { details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ManagerError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    if (options?.details) this.details = options.details;
  }

  toEnvelope(): ErrorEnvelope {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

export function unauthorized(message = "Missing or invalid API key"): ManagerError {
  return new ManagerError("UNAUTHORIZED", message);
}

export function forbidden(message: string, details?: Record<string, unknown>): ManagerError {
  return new ManagerError("FORBIDDEN", message, details ? { details } : undefined);
}

export function validationFailed(message: string, details?: Record<string, unknown>): ManagerError {
  return new ManagerError("VALIDATION_FAILED", message, details ? { details } : undefined);
}

export function walletNotFound(id: string): ManagerError {
  return new ManagerError("WALLET_NOT_FOUND", `No wallet for "${id}"`, { details: { id } });
}

/**
 * A wallet whose row exists but whose upstream address has not been confirmed. Distinct from
 * "not found" because the fix is a retry (`POST /v1/wallets/:id/reconcile`), not a create.
 */
export function walletNotReady(id: string): ManagerError {
  return new ManagerError(
    "WALLET_NOT_READY",
    `Wallet "${id}" is still provisioning; reconcile it before signing`,
    { details: { id } },
  );
}

export function walletDisabled(id: string): ManagerError {
  return new ManagerError("WALLET_DISABLED", `Wallet "${id}" is disabled`, { details: { id } });
}

export function internalError(message = "Internal error", cause?: unknown): ManagerError {
  return new ManagerError("INTERNAL_ERROR", message, cause !== undefined ? { cause } : undefined);
}
