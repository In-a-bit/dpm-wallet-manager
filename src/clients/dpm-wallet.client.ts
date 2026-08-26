import { Inject, Injectable } from "@nestjs/common";

import type { Config } from "../config";
import { ManagerError, type ErrorCode } from "../errors";
import { logWarn } from "../observability/log";
import { CONFIG } from "../tokens";
import type {
  UpstreamAddress,
  UpstreamAddressPage,
  UpstreamAttestation,
  UpstreamHealth,
  UpstreamMetaTxKind,
  UpstreamMetaTxRequest,
  UpstreamSignedCancel,
  UpstreamSignedOrder,
  UpstreamSignOrderRequest,
  UpstreamSubmitTransactionRequest,
} from "./dpm-wallet.types";

/** The upstream error envelope, which this service translates rather than passes through. */
type UpstreamEnvelope = {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
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
  VAULT_NOT_INITIALIZED: "UPSTREAM_UNAVAILABLE",
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

  metaTx(
    kind: UpstreamMetaTxKind,
    request: UpstreamMetaTxRequest,
    options: UpstreamCallOptions = {},
  ): Promise<UpstreamSubmitTransactionRequest> {
    return this.request("POST", `/v1/meta-tx/${kind}`, { body: request, ...options });
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

    logWarn("upstream.rejected", { method, path, status, upstreamCode });
    return new UpstreamError(code, envelope?.error?.message ?? `dpm-wallet returned ${status}`, {
      ...(upstreamCode === undefined ? {} : { upstreamCode }),
      details: {
        upstream: upstreamCode ?? null,
        status,
        ...(envelope?.error?.details ? { upstreamDetails: envelope.error.details } : {}),
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
