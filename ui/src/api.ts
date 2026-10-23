/**
 * Typed client for the dpm-wallet-manager /v1 API. The session lives in an HttpOnly cookie the
 * browser sends for us; every request carries X-Requested-With, which the server's CSRF guard
 * requires on non-GET calls.
 */

export type UiRole = "owner" | "operator" | "viewer";
export type ApiRole = "admin" | "operator" | "readonly";
export type UserStatus = "active" | "disabled";

export interface UiUserDto {
  id: string;
  username: string;
  role: UiRole;
  status: UserStatus;
  createdAt: string;
  lastLoginAt: string | null;
  createdByKeyId: string | null;
  createdByUserId: string | null;
}

export interface SessionDto {
  user: UiUserDto;
  actorRole: ApiRole;
  expiresAt: string;
}

export type WalletKind = "user" | "master" | "operations";
export type WalletStatus = "provisioning" | "active" | "disabled";

export interface Wallet {
  id: string;
  kind: WalletKind;
  externalId: string | null;
  label: string | null;
  status: WalletStatus;
  address: string;
  proxyAddress: string;
  dpmRegistered: boolean;
  ref: string;
  createdAt: string;
  updatedAt: string;
}

export interface PlatformDto {
  mode: "segregated" | "shared";
  modeBurnedAt: string | null;
  masterWallet: Wallet | null;
  operationsWallet: Wallet | null;
  walletCount: number;
  upstream: { reachable: boolean; vault?: { initialized: boolean; ready: boolean } };
}

export interface WalletBalance {
  walletId: string;
  proxyAddress: string | null;
  /** Micro-USDC as an integer string; null while the wallet is still provisioning. */
  balanceMicro: string | null;
  blockNumber: number | null;
}

export interface TransferBody {
  amountDecimal: string;
  recipient?: string;
  recipientWalletId?: string;
}

export interface TransferResult {
  operationId: string;
  relayerTransactionId: string;
  state: string | null;
  external: boolean;
}

export interface TransferStatus {
  relayerTransactionId: string;
  state: string | null;
  transactionHash: string | null;
}

export const OPERATION_KINDS = ["order", "cancel", "allowance", "redeem", "split", "merge", "withdraw"] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

export interface Operation {
  id: string;
  walletId: string;
  signerWalletId: string;
  kind: OperationKind;
  mode: string;
  requestHash: string;
  resultSummary: string | null;
  status: string;
  apiKeyId: string | null;
  uiUserId: string | null;
  createdAt: string;
}

export type AuditOutcome = "success" | "denied" | "failure";

export interface AuditEvent {
  id: number;
  actorKeyId: string | null;
  actorRole: string | null;
  actorUserId: string | null;
  actorUsername: string | null;
  walletId: string | null;
  action: string;
  outcome: AuditOutcome;
  detail: Record<string, unknown> | null;
  requestId: string | null;
  ip: string | null;
  createdAt: string;
}

export const AUDIT_ACTIONS = [
  "key.create", "key.rotate", "key.reveal", "key.revoke", "key.bootstrap", "auth.failed",
  "session.login", "session.logout", "session.password", "user.create", "user.update",
  "platform.mode_burned", "platform.master_wallet_create", "platform.operations_wallet_create",
  "wallet.create", "wallet.reconcile", "wallet.update", "wallet.dpm_attestation", "wallet.dpm_register",
  "wallet.dpm_registered", "sign.order", "sign.cancel", "meta.allowance", "meta.redeem", "meta.split",
  "meta.merge", "meta.withdraw", "meta.withdraw.external",
] as const;

export interface ApiKey {
  id: string;
  role: ApiRole;
  name: string;
  prefix: string;
  status: "active" | "revoked";
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedFromId: string | null;
  createdByKeyId: string | null;
  createdAt: string;
}

export interface MintedApiKey extends ApiKey {
  key: string;
}

export type SettingSource = "default" | "environment" | "dashboard";

export interface RetentionSettings {
  enabled: boolean;
  routineDays: number;
  routedOrderDays: number;
  archiveReminderDays: number;
  sources: Record<"enabled" | "routineDays" | "routedOrderDays" | "archiveReminderDays", SettingSource>;
  defaults: { enabled: boolean; routineDays: number; routedOrderDays: number; archiveReminderDays: number };
  fixed: { idempotencyHours: number; logs: string };
}
export type RetentionPatch = Partial<{ [K in "enabled" | "routineDays" | "routedOrderDays" | "archiveReminderDays"]: RetentionSettings[K] | null }>;

export interface StorageSettings {
  warningPercent: number;
  warningDays: number;
  criticalPercent: number;
  criticalDays: number;
  /** Full for owners; masked to the origin for everyone else. */
  alertWebhookUrl: string | null;
  alertWebhookConfigured: boolean;
  sources: Record<"warningPercent" | "warningDays" | "criticalPercent" | "criticalDays" | "alertWebhookUrl", SettingSource>;
}
export type StoragePatch = Partial<{ [K in Exclude<keyof StorageSettings, "sources" | "alertWebhookConfigured">]: StorageSettings[K] | null }>;

export type StorageLevel = "ok" | "warning" | "critical";

export interface StorageStatus {
  at: string;
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  databases: { wallet: number | null; manager: number };
  tables: { db: string; name: string; bytes: number; estRows: number }[];
  growthBytesPerDay: number | null;
  daysToFull: number | null;
  level: StorageLevel;
  tightened: { routineDays: number; since: string } | null;
  oldestImportantAt: string | null;
  archiveSuggested: boolean;
}

export type ArchiveStatus = "pending" | "downloaded" | "deleting" | "done" | "cancelled";

export interface Archive {
  id: string;
  code: string;
  scope: Record<string, { maxId: number; rows: number }>;
  before: string;
  status: ArchiveStatus;
  sha256: string | null;
  byteSize: number | null;
  rowCount: number | null;
  deleted: Record<string, number> | null;
  createdByUserId: string | null;
  createdByKeyId: string | null;
  createdAt: string;
  downloadedAt: string | null;
  deletedAt: string | null;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

/** Keyset page: no total (counting the biggest tables is the cost avoided), just where to go next. */
export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  limit: number;
}

/** Query values; empty strings and undefined are dropped so filters left blank send nothing. */
export type Query = Record<string, string | number | undefined>;

const FRIENDLY: Record<string, string> = {
  RATE_LIMITED: "Too many attempts. Wait a few minutes and try again.",
  NETWORK: "Cannot reach the server. Check your connection and try again.",
};

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};

/** Registers what to do when a non-login call returns 401 (the app sends the user to sign in). */
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

function buildUrl(path: string, query?: Query): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v !== undefined && v !== "") params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

interface ErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  query?: Query,
  quiet401 = false,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(buildUrl(path, query), {
      method,
      credentials: "same-origin",
      headers: { "X-Requested-With": "dpmm-admin", "Content-Type": "application/json", ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "NETWORK", FRIENDLY.NETWORK);
  }
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!res.ok) {
    const err = (parsed as ErrorBody | null)?.error;
    const code = err?.code ?? `HTTP_${res.status}`;
    const message = err?.message ?? FRIENDLY[code] ?? `Request failed (${res.status}).`;
    if (res.status === 401 && !quiet401) onUnauthorized();
    throw new ApiError(res.status, code, message, err?.details);
  }
  return parsed as T;
}

const get = <T>(path: string, query?: Query) => request<T>("GET", path, undefined, query);
const post = <T>(path: string, body?: unknown) => request<T>("POST", path, body ?? {});

export const api = {
  // Session. login/me/password handle 401 themselves rather than bouncing to the login screen.
  login: (username: string, password: string) =>
    request<SessionDto>("POST", "/v1/session/login", { username, password }, undefined, true),
  logout: () => post<{ loggedOut: true }>("/v1/session/logout"),
  me: () => request<SessionDto>("GET", "/v1/session/me", undefined, undefined, true),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: true }>("POST", "/v1/session/password", { currentPassword, newPassword }, undefined, true),

  // UI users.
  listUsers: (q: Query) => get<Page<UiUserDto>>("/v1/ui-users", q),
  createUser: (body: { username: string; password: string; role: UiRole }) => post<UiUserDto>("/v1/ui-users", body),
  updateUser: (id: string, body: { role?: UiRole; status?: UserStatus; password?: string }) =>
    request<UiUserDto>("PATCH", `/v1/ui-users/${encodeURIComponent(id)}`, body),

  platform: () => get<PlatformDto>("/v1/platform"),

  listWallets: (q: Query) => get<Page<Wallet>>("/v1/wallets", q),
  getWallet: (id: string) => get<Wallet>(`/v1/wallets/${encodeURIComponent(id)}`),

  walletBalances: (walletIds: string[]) => post<WalletBalance[]>("/v1/wallets/balances", { walletIds }),
  createTransfer: (walletId: string, body: TransferBody, idempotencyKey: string) =>
    request<TransferResult>("POST", `/v1/wallets/${encodeURIComponent(walletId)}/transfers`, body, undefined, false, {
      "Idempotency-Key": idempotencyKey,
    }),
  transferStatus: (relayerTransactionId: string) =>
    get<TransferStatus>(`/v1/transfers/${encodeURIComponent(relayerTransactionId)}`),

  listOperations: (q: Query) => get<CursorPage<Operation>>("/v1/operations", q),
  listAudit: (q: Query) => get<CursorPage<AuditEvent>>("/v1/audit", q),

  // Settings.
  getRetentionSettings: () => get<RetentionSettings>("/v1/settings/retention"),
  updateRetentionSettings: (body: RetentionPatch) => request<RetentionSettings>("PUT", "/v1/settings/retention", body),
  getStorageSettings: () => get<StorageSettings>("/v1/settings/storage"),
  updateStorageSettings: (body: StoragePatch) => request<StorageSettings>("PUT", "/v1/settings/storage", body),

  getStorage: () => get<StorageStatus>("/v1/storage"),

  // Archives.
  previewArchive: (before: string) => get<{ tables: Record<string, number> }>("/v1/archives/preview", { before }),
  listArchives: (q: Query) => get<Page<Archive>>("/v1/archives", q),
  createArchive: (before: string) =>
    post<{ id: string; code: string; scope: Archive["scope"] }>("/v1/archives", { before }),
  deleteArchive: (id: string, code: string) =>
    post<{ status: "deleting" }>(`/v1/archives/${encodeURIComponent(id)}/delete`, { code }),
  cancelArchive: (id: string) => post<{ status: "cancelled" }>(`/v1/archives/${encodeURIComponent(id)}/cancel`),

  // API keys.
  listKeys: (q: Query) => get<Page<ApiKey>>("/v1/api-keys", q),
  createKey: (body: { role: ApiRole; name: string; expiresAt?: string }) => post<MintedApiKey>("/v1/api-keys", body),
  revealKey: (id: string) => post<MintedApiKey>(`/v1/api-keys/${encodeURIComponent(id)}/reveal`),
  rotateKey: (id: string, graceSeconds: number) =>
    post<{ created: MintedApiKey; rotated: ApiKey }>(`/v1/api-keys/${encodeURIComponent(id)}/rotate`, { graceSeconds }),
  revokeKey: (id: string) => request<ApiKey>("DELETE", `/v1/api-keys/${encodeURIComponent(id)}`),
};

/** URL the browser navigates to for a download; the session cookie authenticates it. */
export const archiveDownloadUrl = (id: string) => `/v1/archives/${encodeURIComponent(id)}/download`;

/** The message to show for any thrown value. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
