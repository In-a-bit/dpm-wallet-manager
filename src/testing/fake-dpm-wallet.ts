import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { getAddress, keccak256, toHex } from "viem";

import type {
  UpstreamAddress,
  UpstreamCollateralBalance,
  UpstreamSignOrderRequest,
} from "../clients/dpm-wallet.types";

export const FAKE_UPSTREAM_API_KEY = "upstream-test-key";

/** One dpm-wallet audit row, as `GET /v1/maintenance/audit-export` returns it. */
export type FakeAuditRow = { id: number; createdAt: string; action: string; outcome: string };

export type RecordedRequest = {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
  headers: Record<string, string | undefined>;
};

/**
 * A real HTTP server standing in for dpm-wallet.
 *
 * A server rather than a stubbed client class, because most of what is worth testing about
 * `DpmWalletClient` lives *between* the two: the API-key header, the idempotency header, the
 * error-envelope translation, and the timeout. A hand-stubbed method would assert none of it.
 *
 * It reproduces only what this service depends on, and it signs nothing — the signatures are
 * deterministic nonsense derived from the ref, which is enough for a passthrough to be checked.
 */
export class FakeDpmWallet {
  private server: Server | undefined;
  private port = 0;
  /** What `baseUrl` reports; a wildcard bind is still dialled as loopback. */
  private host = "127.0.0.1";

  readonly addresses = new Map<string, UpstreamAddress>();
  readonly requests: RecordedRequest[] = [];

  /** Replayed responses, so a test can assert the idempotency key is actually forwarded. */
  private readonly idempotent = new Map<string, unknown>();

  /** Queued failures, consumed one per matching request. */
  private readonly failures: { status: number; body: unknown }[] = [];

  /** When set, every request hangs, so the client's timeout can be exercised. */
  hang = false;

  /** Set false to make the vault look uninitialised in `GET /v1/health`. */
  vaultInitialized = true;

  /**
   * When set, `POST /v1/addresses/:ref/dpm-register` fails with this envelope. Route-scoped
   * rather than queued like `failNextWith`, because provisioning mints the address first and a
   * positional failure would land on the wrong call.
   */
  failRegistrationWith: { status: number; code: string } | undefined;

  /** Set true to answer `POST /v1/balances` the way an install without a data-api does. */
  balancesUnavailable = false;

  /** Configured balances, keyed by lower-cased address. An unlisted address reads as empty. */
  private readonly balanceByAddress = new Map<string, Partial<UpstreamCollateralBalance>>();

  /** The id `POST /v1/relay` answers with; generated per relay when unset. */
  relayTransactionId: string | undefined;

  /** The state `POST /v1/relay` answers with. */
  relayState = "STATE_NEW";

  /** Set true to answer with the relayer's snake_case spelling (`transaction_id`). */
  relaySnakeCase = false;

  /** What `GET /v1/relay/:id` reports for a transaction this fake relayed. */
  relayStatusState = "STATE_MINED";
  relayStatusHash: string | null = null;

  /** When set, `POST /v1/relay` fails with this envelope; route-scoped, as signing comes first. */
  failRelayWith: { status: number; code: string } | undefined;

  /** The last body `/v1/meta-tx/*` answered with, so a relay can be compared against it. */
  lastSigned: Record<string, unknown> | undefined;

  /**
   * dpm-wallet's important audit rows (the ones only an archive removes), as its maintenance
   * endpoints see them. dpm-wallet owns the important/routine predicate; this fake holds only the
   * rows that already pass it.
   */
  readonly importantAudit: FakeAuditRow[] = [];

  /** When set, `GET /v1/maintenance/audit-export` waits for it before answering. */
  holdExport: Promise<void> | undefined;

  /** Relayed transaction ids, against the `from` they were submitted with. */
  private readonly relayed = new Map<string, string>();

  private nextIndex = 0;
  private nextRelay = 0;

  /**
   * Port 0 by default, so parallel jest workers cannot collide on one, and loopback-only so a
   * test double is never reachable from outside the machine. The standalone runner widens the
   * host deliberately, to be reachable from a container.
   */
  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    this.host = host === "0.0.0.0" ? "127.0.0.1" : host;
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(port, host, resolve));
    this.port = (this.server?.address() as AddressInfo).port;
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    this.server = undefined;
  }

  get baseUrl(): string {
    return `http://${this.host}:${this.port}`;
  }

  /** Makes the next matching call fail with an upstream error envelope. */
  failNextWith(status: number, code: string, message = "upstream said no"): void {
    this.failures.push({ status, body: { error: { code, message } } });
  }

  reset(): void {
    this.requests.length = 0;
    this.failures.length = 0;
    this.idempotent.clear();
    this.hang = false;
    this.vaultInitialized = true;
    this.failRegistrationWith = undefined;
    this.balancesUnavailable = false;
    this.balanceByAddress.clear();
    this.relayTransactionId = undefined;
    this.relayState = "STATE_NEW";
    this.relaySnakeCase = false;
    this.relayStatusState = "STATE_MINED";
    this.relayStatusHash = null;
    this.failRelayWith = undefined;
    this.lastSigned = undefined;
    this.relayed.clear();
    this.importantAudit.length = 0;
    this.holdExport = undefined;
  }

  /** Sets what `POST /v1/balances` reports for an address. */
  setBalance(address: string, balance: Partial<UpstreamCollateralBalance>): void {
    this.balanceByAddress.set(address.toLowerCase(), balance);
  }

  /** Seeds an address as if it had been minted, for the reconcile paths. */
  seedAddress(ref: string): UpstreamAddress {
    const address = this.mint(ref);
    this.addresses.set(ref, address);
    return address;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await readBody(request);
    const path = request.url ?? "";
    this.requests.push({
      method: request.method ?? "GET",
      path,
      body,
      headers: {
        "x-api-key": header(request, "x-api-key"),
        "idempotency-key": header(request, "idempotency-key"),
      },
    });

    if (this.hang) return; // never responds; the client's AbortSignal is what ends it

    const route = path.split("?")[0] ?? "";
    if (route !== "/v1/health" && header(request, "x-api-key") !== FAKE_UPSTREAM_API_KEY) {
      return send(response, 401, { error: { code: "UNAUTHORIZED", message: "bad key" } });
    }

    const failure = this.failures.shift();
    if (failure) return send(response, failure.status, failure.body);

    // Replay, exactly as dpm-wallet's interceptor does, so a forwarded key is observable.
    const idempotencyKey = header(request, "idempotency-key");
    if (idempotencyKey && this.idempotent.has(idempotencyKey)) {
      return send(response, 200, this.idempotent.get(idempotencyKey));
    }

    if (route === "/v1/maintenance/audit-export" && this.holdExport) await this.holdExport;

    const authenticated = header(request, "x-api-key") === FAKE_UPSTREAM_API_KEY;
    const result = this.route(request.method ?? "GET", route, body, path, authenticated);
    if (!result) {
      return send(response, 404, { error: { code: "NOT_FOUND", message: `no route ${route}` } });
    }
    if (idempotencyKey && result.status < 400) this.idempotent.set(idempotencyKey, result.body);
    send(response, result.status, result.body);
  }

  private route(
    method: string,
    route: string,
    body: Record<string, unknown> | undefined,
    path = route,
    authenticated = true,
  ): { status: number; body: unknown } | undefined {
    if (route === "/v1/health") {
      // Like dpm-wallet: the vault detail only goes to a caller presenting the key.
      return {
        status: 200,
        body: {
          status: "ok",
          ...(authenticated
            ? { vault: { mode: "turnkey", initialized: this.vaultInitialized, ready: true } }
            : {}),
        },
      };
    }

    // Maintenance endpoints, with dpm-wallet's semantics over `importantAudit`.
    if (route.startsWith("/v1/maintenance/")) {
      const query = new URLSearchParams(path.split("?")[1] ?? "");
      const before = method === "GET" ? (query.get("before") ?? "") : readString(body, "before");
      // dpm-wallet's guard: a cutoff newer than 24 h ago is refused.
      if (!(Date.parse(before) <= Date.now() - 24 * 60 * 60_000)) {
        return {
          status: 400,
          body: { error: { code: "VALIDATION_FAILED", message: "before must be 24 h old" } },
        };
      }
      const older = this.importantAudit
        .filter((row) => Date.parse(row.createdAt) < Date.parse(before))
        .sort((a, b) => a.id - b.id);
      if (route === "/v1/maintenance/purge-routine-audit" && method === "POST") {
        return { status: 200, body: { deleted: 0 } };
      }
      if (route === "/v1/maintenance/audit-scope" && method === "GET") {
        return {
          status: 200,
          body: { maxId: Math.max(0, ...older.map((row) => row.id)), rows: older.length },
        };
      }
      if (route === "/v1/maintenance/audit-export" && method === "GET") {
        const maxId = Number(query.get("maxId"));
        const after = Number(query.get("cursor") ?? 0);
        const limit = Number(query.get("limit") ?? 1000);
        const items = older.filter((row) => row.id <= maxId && row.id > after).slice(0, limit);
        const last = items.at(-1);
        const nextCursor = last && items.length === limit ? String(last.id) : null;
        return { status: 200, body: { items, nextCursor } };
      }
      if (route === "/v1/maintenance/delete-archived-audit" && method === "POST") {
        const maxId = Number(body?.maxId);
        const batch = Number(body?.batch);
        const doomed = new Set(
          older
            .filter((row) => row.id <= maxId)
            .slice(0, batch)
            .map((row) => row.id),
        );
        for (let i = this.importantAudit.length - 1; i >= 0; i--) {
          if (doomed.has(this.importantAudit[i]?.id ?? -1)) this.importantAudit.splice(i, 1);
        }
        return { status: 200, body: { deleted: doomed.size } };
      }
    }

    if (route === "/v1/addresses" && method === "POST") {
      const ref = readString(body, "ref");
      if (this.addresses.has(ref)) {
        return {
          status: 409,
          body: { error: { code: "REF_ALREADY_EXISTS", message: `ref ${ref} exists` } },
        };
      }
      return { status: 200, body: this.seedAddress(ref) };
    }

    const addressMatch = /^\/v1\/addresses\/([^/]+)(\/[a-z-]+)?$/.exec(route);
    if (addressMatch) {
      const ref = decodeURIComponent(addressMatch[1] ?? "");
      const suffix = addressMatch[2];
      const existing = this.addresses.get(ref);
      if (!existing) {
        return {
          status: 404,
          body: { error: { code: "ADDRESS_NOT_FOUND", message: `no address for ${ref}` } },
        };
      }
      if (!suffix) return { status: 200, body: existing };
      if (suffix === "/dpm-attestation") {
        return {
          status: 200,
          body: { address: existing.address, signature: signatureFor(`attest:${ref}`) },
        };
      }
      // Signs, posts to dpm-api and records the flag upstream: from here only the outcome is
      // visible, which is the flag coming back set.
      if (suffix === "/dpm-register") {
        if (this.failRegistrationWith) {
          const { status, code } = this.failRegistrationWith;
          return { status, body: { error: { code, message: "dpm-api said no" } } };
        }
        const registered = { ...existing, dpmRegistered: true };
        this.addresses.set(ref, registered);
        return { status: 200, body: registered };
      }
      if (suffix === "/dpm-registered") {
        const updated = { ...existing, dpmRegistered: body?.registered !== false };
        this.addresses.set(ref, updated);
        return { status: 200, body: updated };
      }
    }

    if (route === "/v1/balances" && method === "POST") {
      if (this.balancesUnavailable) {
        return {
          status: 503,
          body: { error: { code: "BALANCES_UNAVAILABLE", message: "no data-api configured" } },
        };
      }
      const addresses = Array.isArray(body?.addresses) ? (body.addresses as string[]) : [];
      // data-api refuses the whole batch when any address has no platform `users` row, and
      // dpm-wallet passes that refusal on as an upstream failure.
      const unknown = addresses.find((address) => !this.isRegistered(address));
      if (unknown) {
        return {
          status: 502,
          body: {
            error: {
              code: "RELAYER_REQUEST_FAILED",
              message: `data-api /balances/batch-get failed with 403: ${unknown} is not readable`,
            },
          },
        };
      }
      return { status: 200, body: addresses.map((address) => this.balanceFor(address)) };
    }

    // dpm-wallet answers a relay with 201, which the client has to accept like any 2xx.
    if (route === "/v1/relay" && method === "POST") {
      if (this.failRelayWith) {
        const { status, code } = this.failRelayWith;
        return { status, body: { error: { code, message: "the relayer said no" } } };
      }
      const from = readString(body, "from");
      const held = [...this.addresses.values()].some(
        (address) => address.address.toLowerCase() === from.toLowerCase(),
      );
      if (!held) {
        return {
          status: 404,
          body: { error: { code: "ADDRESS_NOT_FOUND", message: `no key for ${from}` } },
        };
      }
      const id = this.relayTransactionId ?? `relay-tx-${++this.nextRelay}`;
      this.relayed.set(id, from);
      return {
        status: 201,
        body: this.relaySnakeCase
          ? { transaction_id: id, state: this.relayState }
          : { transactionID: id, state: this.relayState },
      };
    }

    const relayMatch = /^\/v1\/relay\/([^/]+)$/.exec(route);
    if (relayMatch && method === "GET") {
      const id = decodeURIComponent(relayMatch[1] ?? "");
      const from = new URLSearchParams(path.split("?")[1] ?? "").get("from") ?? "";
      if (this.relayed.get(id)?.toLowerCase() !== from.toLowerCase()) {
        return {
          status: 404,
          body: { error: { code: "RELAY_TRANSACTION_NOT_FOUND", message: `no transaction ${id}` } },
        };
      }
      return {
        status: 200,
        body: {
          transactionID: id,
          state: this.relayStatusState,
          from,
          ...(this.relayStatusHash === null ? {} : { transactionHash: this.relayStatusHash }),
        },
      };
    }

    if (route === "/v1/sign/order" && method === "POST") {
      return this.signOrder(body as unknown as UpstreamSignOrderRequest);
    }

    if (route === "/v1/sign/cancel" && method === "POST") {
      const ref = readString(body, "ref");
      if (!this.addresses.has(ref)) {
        return {
          status: 404,
          body: { error: { code: "ADDRESS_NOT_FOUND", message: `no address for ${ref}` } },
        };
      }
      return {
        status: 200,
        body: {
          orderHash: readString(body, "orderHash"),
          message: `Cancel order: ${readString(body, "orderHash")} on market: ${readString(body, "marketId")}`,
          signature: signatureFor(`cancel:${ref}:${readString(body, "orderHash")}`),
        },
      };
    }

    const metaMatch = /^\/v1\/meta-tx\/(allowance|redeem|split|merge|withdraw)$/.exec(route);
    if (metaMatch && method === "POST") {
      const ref = readString(body, "ref");
      const existing = this.addresses.get(ref);
      if (!existing) {
        return {
          status: 404,
          body: { error: { code: "ADDRESS_NOT_FOUND", message: `no address for ${ref}` } },
        };
      }
      if (!existing.dpmRegistered) {
        return {
          status: 409,
          body: {
            code: "CUSTOMER_NOT_REGISTERED",
            error: { code: "CUSTOMER_NOT_REGISTERED", message: `${ref} is not registered` },
          },
        };
      }
      this.lastSigned = {
        from: existing.address,
        to: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052",
        proxyWallet: existing.proxyAddress,
        data: signatureFor(`data:${metaMatch[1]}:${ref}`),
        nonce: "0",
        signature: signatureFor(`meta:${metaMatch[1]}:${ref}`),
        signatureParams: { gasPrice: "0", gasLimit: "300000", relayerFee: "0" },
        type: "PROXY",
        metadata: metaMatch[1],
      };
      return { status: 200, body: this.lastSigned };
    }

    return undefined;
  }

  private signOrder(request: UpstreamSignOrderRequest): { status: number; body: unknown } {
    const existing = this.addresses.get(request.ref);
    if (!existing) {
      return {
        status: 404,
        body: { error: { code: "ADDRESS_NOT_FOUND", message: `no address for ${request.ref}` } },
      };
    }
    const priceMicro = Math.round(request.price * 1_000_000);
    const sharesMicro = Math.round(request.shares * 1_000_000);
    const collateralMicro = Math.round((priceMicro * sharesMicro) / 1_000_000);
    return {
      status: 200,
      body: {
        order: {
          salt: "1",
          maker: request.maker,
          // The signer is whichever key the ref selects — the property the routing rules turn on.
          signer: existing.address,
          taker: "0x0000000000000000000000000000000000000000",
          // dpm-wallet encodes an omitted recipient as the zero address.
          recipient: request.recipient ?? "0x0000000000000000000000000000000000000000",
          tokenId: request.tokenId,
          makerAmount: String(request.side === 0 ? collateralMicro : sharesMicro),
          takerAmount: String(request.side === 0 ? sharesMicro : collateralMicro),
          expiration: "0",
          nonce: "0",
          feeRateBps: String(request.feeRateBps),
          side: request.side,
          signatureType: 1,
        },
        signature: signatureFor(`order:${request.ref}:${request.tokenId}`),
        orderHash: keccak256(toHex(`hash:${request.ref}:${request.tokenId}:${request.side}`)),
      },
    };
  }

  /** Whether data-api would know this address: one this fake holds and has marked registered. */
  private isRegistered(address: string): boolean {
    const wanted = address.toLowerCase();
    return [...this.addresses.values()].some(
      (held) =>
        held.dpmRegistered &&
        (held.address.toLowerCase() === wanted || held.proxyAddress.toLowerCase() === wanted),
    );
  }

  private balanceFor(address: string): UpstreamCollateralBalance {
    const configured = this.balanceByAddress.get(address.toLowerCase()) ?? {};
    const decimals = configured.decimals ?? 6;
    const balanceRaw = configured.balanceRaw ?? "0";
    return {
      user: address,
      decimals,
      balanceRaw,
      balance: Number(balanceRaw) / 10 ** decimals,
      allowanceRaw: configured.allowanceRaw ?? null,
      updatedAt: new Date().toISOString(),
      ...(configured.blockNumber === undefined ? {} : { blockNumber: configured.blockNumber }),
    };
  }

  private mint(ref: string): UpstreamAddress {
    const eoa = addressFrom(`eoa:${ref}`);
    return {
      ref,
      index: this.nextIndex++,
      address: eoa,
      proxyAddress: addressFrom(`proxy:${eoa}`),
      dpmRegistered: false,
      createdAt: new Date().toISOString(),
    };
  }
}

/** Deterministic, so a reconcile after a "crash" returns the address the first call minted. */
function addressFrom(seed: string): string {
  return getAddress(`0x${keccak256(toHex(seed)).slice(-40)}`);
}

function signatureFor(seed: string): string {
  return `${keccak256(toHex(seed))}${keccak256(toHex(`${seed}:b`)).slice(2)}1b`;
}

/** Bodies arrive as `unknown` values; a non-string ref is a caller bug, not a route to guess at. */
function readString(body: Record<string, unknown> | undefined, key: string): string {
  const value = body?.[key];
  return typeof value === "string" ? value : "";
}

function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

async function readBody(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? {});
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(payload);
}
