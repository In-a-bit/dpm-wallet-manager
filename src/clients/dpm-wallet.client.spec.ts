import { loadConfig } from "../config";
import { FAKE_UPSTREAM_API_KEY, FakeDpmWallet } from "../testing/fake-dpm-wallet";
import { testEnv } from "../testing/env";
import { DpmWalletClient, UpstreamError } from "./dpm-wallet.client";

/**
 * The translation layer between dpm-wallet's error vocabulary and ours. What matters here is that
 * a caller can tell apart the three outcomes it has to act on differently — retry, register the
 * wallet first, or give up — and that the original code survives for whoever is debugging.
 */
describe("DpmWalletClient", () => {
  const upstream = new FakeDpmWallet();
  let client: DpmWalletClient;

  beforeAll(async () => {
    const baseUrl = await upstream.start();
    client = new DpmWalletClient(
      loadConfig(
        testEnv({
          DATABASE_URL: "postgres://unused/unused",
          DPM_WALLET_BASE_URL: baseUrl,
          DPM_WALLET_API_KEY: FAKE_UPSTREAM_API_KEY,
          DPM_WALLET_TIMEOUT_MS: "300",
        }),
      ),
    );
  });

  afterAll(async () => {
    await upstream.stop();
  });

  beforeEach(() => {
    upstream.reset();
  });

  it("sends the configured key and returns the decoded body", async () => {
    const address = await client.createAddress("mgr:a");
    expect(address.ref).toBe("mgr:a");
    expect(upstream.requests.at(-1)?.headers["x-api-key"]).toBe(FAKE_UPSTREAM_API_KEY);
  });

  it("forwards an idempotency key, and the upstream replays on it", async () => {
    const first = await client.createAddress("mgr:idem", { idempotencyKey: "same" });
    // A second call with the same key would ordinarily conflict on the ref; the replay is what
    // makes a retry safe, and it only happens because the header was forwarded.
    const second = await client.createAddress("mgr:idem", { idempotencyKey: "same" });
    expect(second).toEqual(first);
  });

  it("maps a 422 RELAY_REJECTED from relay() to TRANSFER_REJECTED", async () => {
    upstream.failRelayWith = { status: 422, code: "RELAY_REJECTED" };
    const error = await client
      .relay({ from: "0xfrom", to: "0xto", data: "0x", nonce: "1", signature: "0x" } as never)
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).code).toBe("TRANSFER_REJECTED");
    expect((error as UpstreamError).status).toBe(422);
  });

  it("renames CUSTOMER_NOT_REGISTERED to our own vocabulary, keeping the original in details", async () => {
    upstream.failNextWith(409, "CUSTOMER_NOT_REGISTERED", "not registered");
    const error = await client.metaTx("allowance", { ref: "mgr:x" }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).code).toBe("WALLET_NOT_REGISTERED");
    expect((error as UpstreamError).status).toBe(409);
    expect((error as UpstreamError).details).toMatchObject({ upstream: "CUSTOMER_NOT_REGISTERED" });
  });

  it("keeps REF_ALREADY_EXISTS reachable, since provisioning branches on it", async () => {
    await client.createAddress("mgr:dup");
    const error = await client.createAddress("mgr:dup").catch((err: unknown) => err);
    expect((error as UpstreamError).upstreamCode).toBe("REF_ALREADY_EXISTS");
  });

  it("treats a 5xx as unavailable and a 4xx as rejected", async () => {
    upstream.failNextWith(503, "INTERNAL_ERROR");
    const unavailable = await client.health().catch((err: unknown) => err);
    expect((unavailable as UpstreamError).code).toBe("UPSTREAM_UNAVAILABLE");

    upstream.failNextWith(400, "VALIDATION_FAILED");
    const rejected = await client.health().catch((err: unknown) => err);
    expect((rejected as UpstreamError).code).toBe("UPSTREAM_REJECTED");
  });

  it("reports an unreachable upstream rather than hanging", async () => {
    upstream.hang = true;
    const error = await client.health().catch((err: unknown) => err);
    expect((error as UpstreamError).code).toBe("UPSTREAM_UNAVAILABLE");
    expect((error as UpstreamError).message).toMatch(/could not be reached/);
  });

  it("reports a refused connection the same way as a timeout", async () => {
    const offline = new DpmWalletClient(
      loadConfig(
        testEnv({
          DATABASE_URL: "postgres://unused/unused",
          // Port 1 is reserved; nothing listens there.
          DPM_WALLET_BASE_URL: "http://127.0.0.1:1",
          DPM_WALLET_TIMEOUT_MS: "300",
        }),
      ),
    );
    const error = await offline.health().catch((err: unknown) => err);
    expect((error as UpstreamError).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("never leaks our key into the error it raises", async () => {
    upstream.failNextWith(500, "INTERNAL_ERROR");
    const error = await client.health().catch((err: unknown) => err);
    expect(JSON.stringify((error as UpstreamError).toEnvelope())).not.toContain(
      FAKE_UPSTREAM_API_KEY,
    );
  });

  describe("maintenance endpoints", () => {
    it("purgeRoutineAudit posts before and batch", async () => {
      const result = await client.purgeRoutineAudit("2026-01-01T00:00:00.000Z", 5000);
      expect(result).toEqual({ deleted: 0 });
      const last = upstream.requests.at(-1);
      expect(last?.method).toBe("POST");
      expect(last?.path).toBe("/v1/maintenance/purge-routine-audit");
      expect(last?.body).toEqual({ before: "2026-01-01T00:00:00.000Z", batch: 5000 });
    });

    it("auditScope sends before as a query parameter", async () => {
      expect(await client.auditScope("2026-01-01T00:00:00.000Z")).toEqual({ maxId: 0, rows: 0 });
      expect(upstream.requests.at(-1)?.path).toBe(
        "/v1/maintenance/audit-scope?before=2026-01-01T00%3A00%3A00.000Z",
      );
    });

    it("auditExport sends the cursor and limit only when given", async () => {
      await client.auditExport({ before: "2026-01-01T00:00:00.000Z", maxId: 9 });
      expect(upstream.requests.at(-1)?.path).toBe(
        "/v1/maintenance/audit-export?before=2026-01-01T00%3A00%3A00.000Z&maxId=9",
      );
      const page = await client.auditExport({
        before: "2026-01-01T00:00:00.000Z",
        maxId: 9,
        cursor: "5",
        limit: 500,
      });
      expect(page).toEqual({ items: [], nextCursor: null });
      expect(upstream.requests.at(-1)?.path).toContain("&cursor=5&limit=500");
    });

    it("deleteArchivedAudit posts before, maxId and batch", async () => {
      expect(
        await client.deleteArchivedAudit({
          before: "2026-01-01T00:00:00.000Z",
          maxId: 9,
          batch: 100,
        }),
      ).toEqual({ deleted: 0 });
      expect(upstream.requests.at(-1)?.body).toEqual({
        before: "2026-01-01T00:00:00.000Z",
        maxId: 9,
        batch: 100,
      });
    });

    it("maps an upstream refusal to UPSTREAM_REJECTED", async () => {
      upstream.failNextWith(400, "VALIDATION_FAILED", "too recent");
      await expect(client.purgeRoutineAudit(new Date().toISOString(), 10)).rejects.toMatchObject({
        code: "UPSTREAM_REJECTED",
        upstreamCode: "VALIDATION_FAILED",
      });
    });
  });
});
