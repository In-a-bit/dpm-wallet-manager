import { Inject, Injectable } from "@nestjs/common";

import type { Config } from "../config";
import { ManagerError, type ErrorCode } from "../errors";
import { logWarn } from "../observability/log";
import { CONFIG } from "../tokens";
import type {
  UpstreamAddress,
  UpstreamAddressPage,
  UpstreamAttestation,
  UpstreamAuditExportPage,
  UpstreamAuditExportQuery,
  UpstreamAuditScope,
  UpstreamCollateralBalance,
  UpstreamDeleted,
  UpstreamDeleteArchivedRequest,
  UpstreamHealth,
  UpstreamMetaTxKind,
  UpstreamMetaTxRequest,
  UpstreamRelayTransaction,
  UpstreamSignedCancel,
  UpstreamSignedOrder,
  UpstreamSignOrderRequest,
  UpstreamSubmitTransactionRequest,
} from "./dpm-wallet.types";

/** The upstream error envelope, which this service translates rather than passes through. */
type UpstreamEnvelope = {
  error?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    requestId?: string;
  };
};

/**
 * How each dpm-wallet error code surfaces to our caller.
 *
 * Two of them are deliberately renamed. `CUSTOMER_NOT_REGISTERED` becomes
 * `WALLET_NOT_REGISTERED` because "customer" is dpm-wallet's word for what we call a wallet, and
 * a caller reading our documentation would not find it. `IDEMPOTENCY_CONFLICT` keeps its name
 * because it means the same thing at both layers.
 *
 * Everything else collapses into `UPSTREAM_REJECTED`: the distinction between "the vault refused
 * to sign" and "the relayer was unreachable" is not one our caller can act on differently, and
 * the original code travels in `details.upstream` for whoever is debugging.
 */
const CODE_MAP: Record<string, ErrorCode> = {
  CUSTOMER_NOT_REGISTERED: "WALLET_NOT_REGISTERED",
  IDEMPOTENCY_CONFLICT: "IDEMPOTENCY_CONFLICT",
  // The same key is still being executed upstream (our earlier attempt timed out): retry later.
  IDEMPOTENCY_IN_PROGRESS: "UPSTREAM_UNAVAILABLE",
  VAULT_NOT_INITIALIZED: "UPSTREAM_UNAVAILABLE",
  BALANCES_UNAVAILABLE: "BALANCES_UNAVAILABLE",
  // Only ever answered for an id this service relayed, so to our caller the transfer is unknown.
  RELAY_TRANSACTION_NOT_FOUND: "TRANSFER_NOT_FOUND",
  // The relayer looked at the transfer and said no; resending it unchanged gets the same answer,
  // so it must not fall through to UPSTREAM_UNAVAILABLE's "safe to retry".
  RELAY_REJECTED: "TRANSFER_REJECTED",
};

/** Upstream codes the caller is expected to handle rather than treat as a failure. */
export const UPSTREAM_REF_ALREADY_EXISTS = "REF_ALREADY_EXISTS";
export const UPSTREAM_ADDRESS_NOT_FOUND = "ADDRESS_NOT_FOUND";

/** Carries the upstream's own code, so the wallet service can branch on `REF_ALREADY_EXISTS`. */
export class UpstreamError extends ManagerError {
  readonly upstreamCode: string | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    options: { upstreamCode?: string; details?: Record<string, unknown>; cause?: unknown },
  ) {
    super(code, message, options);
    this.name = "UpstreamError";
    this.upstreamCode = options.upstreamCode;
  }
}

export type UpstreamCallOptions = {
  /**
   * Forwarded as `Idempotency-Key`. dpm-wallet stores the key against a hash of the body and
   * replays the stored response, so a retry produces the original signature rather than a second,
   * differently-salted one.
   */
  idempotencyKey?: string;
};

/**
 * The only thing in this service that talks to dpm-wallet.
 *
 * Every method is a thin, typed call: shape the body, send it, translate the outcome. There is
 * no retry on a POST — a signing call is not safely repeatable without an idempotency key, and
 * whether one was supplied is the caller's decision, not this client's.
 */
@Injectable()
export class DpmWalletClient {
  constructor(@Inject(CONFIG) private readonly config: Config) {}

  health(): Promise<UpstreamHealth> {
    return this.request("GET", "/v1/health");
  }

  createAddress(ref: string, options: UpstreamCallOptions = {}): Promise<UpstreamAddress> {
    return this.request("POST", "/v1/addresses", { body: { ref }, ...options });
  }

  getAddress(ref: string): Promise<UpstreamAddress> {
    return this.request("GET", `/v1/addresses/${encodeURIComponent(ref)}`);
  }

  listAddresses(limit: number, offset: number): Promise<UpstreamAddressPage> {
    return this.request("GET", `/v1/addresses?limit=${limit}&offset=${offset}`);
  }

  signDpmAttestation(ref: string): Promise<UpstreamAttestation> {
    return this.request("POST", `/v1/addresses/${encodeURIComponent(ref)}/dpm-attestation`);
  }

  /**
   * Signs the attestation, registers the address with dpm-api and records the flag, upstream,
   * in one call. Idempotent there: an address already registered comes back untouched.
   */
  dpmRegister(ref: string): Promise<UpstreamAddress> {
    return this.request("POST", `/v1/addresses/${encodeURIComponent(ref)}/dpm-register`);
  }

  setDpmRegistered(ref: string, registered: boolean): Promise<UpstreamAddress> {
    return this.request("POST", `/v1/addresses/${encodeURIComponent(ref)}/dpm-registered`, {
      body: { registered },
    });
  }

  signOrder(
    request: UpstreamSignOrderRequest,
    options: UpstreamCallOptions = {},
  ): Promise<UpstreamSignedOrder> {
    return this.request("POST", "/v1/sign/order", { body: request, ...options });
  }

  signCancel(
    request: { ref: string; orderHash: string; marketId: string },
    options: UpstreamCallOptions = {},
  ): Promise<UpstreamSignedCancel> {
    return this.request("POST", "/v1/sign/cancel", { body: request, ...options });
  }

  /** Collateral balances for up to 100 addresses, answered in request order. */
  balances(addresses: string[]): Promise<UpstreamCollateralBalance[]> {
    return this.request("POST", "/v1/balances", { body: { addresses } });
  }

  metaTx(
    kind: UpstreamMetaTxKind,
    request: UpstreamMetaTxRequest,
    options: UpstreamCallOptions = {},
  ): Promise<UpstreamSubmitTransactionRequest> {
    return this.request("POST", `/v1/meta-tx/${kind}`, { body: request, ...options });
  }

  /**
   * Submits a signed meta-transaction to relayer-api through dpm-wallet, which answers 201. A
   * relayer refusal (4xx) comes back as dpm-wallet's 422 `RELAY_REJECTED`, which maps to
   * `TRANSFER_REJECTED`.
   */
  relay(
    request: UpstreamSubmitTransactionRequest,
    options: UpstreamCallOptions = {},
  ): Promise<UpstreamRelayTransaction> {
    return this.request("POST", "/v1/relay", { body: request, ...options });
  }

  /** The relayer's view of a transaction; `from` is the EOA that signed it. */
  relayStatus(id: string, from: string): Promise<UpstreamRelayTransaction> {
    return this.request(
      "GET",
      `/v1/relay/${encodeURIComponent(id)}?from=${encodeURIComponent(from)}`,
    );
  }

  /**
   * Deletes one batch of dpm-wallet's routine success audit rows older than `before`. dpm-wallet
   * never picks its own cutoff; the caller loops until a batch comes back short.
   */
  purgeRoutineAudit(before: string, batch: number): Promise<UpstreamDeleted> {
    return this.request("POST", "/v1/maintenance/purge-routine-audit", { body: { before, batch } });
  }

  /** The highest audit id older than `before` and how many rows that scope holds. */
  auditScope(before: string): Promise<UpstreamAuditScope> {
    return this.request("GET", `/v1/maintenance/audit-scope?before=${encodeURIComponent(before)}`);
  }

  /** One page of the audit rows an archive covers, in id order. */
  auditExport(query: UpstreamAuditExportQuery): Promise<UpstreamAuditExportPage> {
    const params = [
      `before=${encodeURIComponent(query.before)}`,
      `maxId=${query.maxId}`,
      ...(query.cursor === undefined ? [] : [`cursor=${encodeURIComponent(query.cursor)}`]),
      ...(query.limit === undefined ? [] : [`limit=${query.limit}`]),
    ];
    return this.request("GET", `/v1/maintenance/audit-export?${params.join("&")}`);
  }

  /** Deletes one batch of rows an operator archived: those at or below `maxId` and before `before`. */
  deleteArchivedAudit(request: UpstreamDeleteArchivedRequest): Promise<UpstreamDeleted> {
    return this.request("POST", "/v1/maintenance/delete-archived-audit", { body: request });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const url = `${this.config.dpmWallet.baseUrl}${path}`;
    // AbortSignal.timeout rather than a manual timer: it aborts the socket, so a hung upstream
    // frees the request slot instead of holding it until the process is restarted.
    const signal = AbortSignal.timeout(this.config.dpmWallet.timeoutMs);

    const headers: Record<string, string> = {
      "X-API-Key": this.config.dpmWallet.apiKey,
      Accept: "application/json",
    };
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers,
        signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch (cause) {
      // A refused connection, a DNS failure and a timeout are one outcome to the caller: the
      // upstream could not be reached, and the request may or may not have been performed.
      logWarn("upstream.unreachable", { method, path, err: cause });
      throw new UpstreamError("UPSTREAM_UNAVAILABLE", "dpm-wallet could not be reached", {
        details: { method, path },
        cause,
      });
    }

    const text = await response.text();
    if (!response.ok) throw this.toError(response.status, text, method, path);
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new UpstreamError("UPSTREAM_REJECTED", "dpm-wallet returned a malformed response", {
        details: { method, path, status: response.status },
        cause,
      });
    }
  }

  private toError(status: number, text: string, method: string, path: string): UpstreamError {
    const envelope = parseEnvelope(text);
    const upstreamCode = envelope?.error?.code;
    // A 5xx means the upstream broke; a 4xx means it refused. Both are "upstream said no" to
    // our caller, but only the first is worth retrying.
    const fallback: ErrorCode = status >= 500 ? "UPSTREAM_UNAVAILABLE" : "UPSTREAM_REJECTED";
    const code: ErrorCode =
      upstreamCode === undefined ? fallback : (CODE_MAP[upstreamCode] ?? fallback);

    // What dpm-wallet said (message, details) stays in our log: it can name Turnkey activities,
    // addresses and other internals the caller has no business seeing. The caller gets our own
    // wording, the upstream code, and dpm-wallet's request id to quote when asking for the log line.
    logWarn("upstream.rejected", {
      method,
      path,
      status,
      upstreamCode,
      upstreamMessage: envelope?.error?.message,
      upstreamDetails: envelope?.error?.details,
      upstreamRequestId: envelope?.error?.requestId,
    });
    return new UpstreamError(code, `dpm-wallet returned ${status}`, {
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
      details: {
        upstream: upstreamCode ?? null,
        status,
        ...(envelope?.error?.requestId ? { upstreamRequestId: envelope.error.requestId } : {}),
      },
    });
  }
}

function parseEnvelope(text: string): UpstreamEnvelope | undefined {
  try {
    return JSON.parse(text) as UpstreamEnvelope;
  } catch {
    return undefined;
  }
}
