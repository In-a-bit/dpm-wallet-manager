import { startHarness, type Harness } from "../src/testing/harness";

/**
 * Wallet provisioning against a stand-in dpm-wallet.
 *
 * The behaviour worth pinning is not that a POST returns 201 — it is that the three-step write
 * order holds under a crash and an unreachable upstream, because the failure it prevents is an
 * address holding customer funds that this service has no record of.
 */
describe("wallets", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(() => {
    harness.upstream.reset();
  });

  const create = (body: Record<string, unknown> = {}, apiKey?: string) =>
    harness.post("/v1/wallets", { body, ...(apiKey ? { apiKey } : {}) });

  describe("creation", () => {
    it("mints an address upstream and records it under the manager's own id", async () => {
      const response = await create({ externalId: "customer-1", label: "Ada" });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({
        kind: "user",
        status: "active",
        externalId: "customer-1",
        label: "Ada",
        dpmRegistered: false,
      });
      expect(response.body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(response.body.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(response.body.proxyAddress).toMatch(/^0x[0-9a-fA-F]{40}$/);
      // The ref is derived from our id, which is what makes the upstream call safe to repeat.
      expect(response.body.ref).toBe(`mgr:${response.body.id}`);
    });

    it("sends the row id as the upstream idempotency key", async () => {
      const response = await create();
      const call = harness.upstream.requests.find((request) => request.path === "/v1/addresses");
      expect(call?.headers["idempotency-key"]).toBe(response.body.id);
      expect(call?.headers["x-api-key"]).toBe("upstream-test-key");
    });

    it("refuses a duplicate external id, whatever its casing", async () => {
      await create({ externalId: "Customer-2" });
      const duplicate = await create({ externalId: "customer-2" });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe("EXTERNAL_ID_TAKEN");
    });

    it("is operator-reachable and admin-reachable, but not unauthenticated", async () => {
      expect((await create({}, harness.operatorKey)).status).toBe(201);
      expect((await harness.post("/v1/wallets", { body: {}, apiKey: null })).status).toBe(401);
    });

    it("cannot be used to mint a platform wallet by passing a kind", async () => {
      const response = await create({ kind: "master" });
      expect(response.status).toBe(201);
      // `whitelist` strips the unknown property rather than honouring it.
      expect(response.body.kind).toBe("user");
    });
  });

  describe("when the upstream is unavailable", () => {
    it("leaves a provisioning row rather than an address nobody knows about", async () => {
      harness.upstream.failNextWith(503, "UPSTREAM", "vault unavailable");
      const response = await create({ externalId: "half-made" });
      expect(response.status).toBe(502);
      expect(response.body.error.code).toBe("UPSTREAM_UNAVAILABLE");

      const stuck = (await harness.wallets.listProvisioning()).find(
        (wallet) => wallet.externalId === "half-made",
      );
      expect(stuck).toBeDefined();
      expect(stuck?.eoaAddress).toBeNull();
    });

    it("refuses to sign for a wallet that never finished provisioning", async () => {
      const stuck = (await harness.wallets.listProvisioning())[0];
      const response = await harness.post(`/v1/wallets/${stuck?.id}/dpm-attestation`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("WALLET_NOT_READY");
    });

    it("completes it on reconcile, reusing the ref rather than minting a second address", async () => {
      const stuck = (await harness.wallets.listProvisioning()).find(
        (wallet) => wallet.externalId === "half-made",
      );
      const response = await harness.post(`/v1/wallets/${stuck?.id}/reconcile`);
      expect(response.status).toBe(200);
      expect(response.body.status).toBe("active");
      expect(response.body.ref).toBe(stuck?.ref);
      expect(response.body.address).toMatch(/^0x/);
    });

    it("adopts the address a first attempt already minted", async () => {
      // The crash this models: dpm-wallet minted the address, we never saw the response.
      const created = await create({ externalId: "raced" });
      const walletId = created.body.id as string;
      await harness.db.query("UPDATE wallets SET status = 'provisioning' WHERE id = $1", [
        walletId,
      ]);

      const reconciled = await harness.post(`/v1/wallets/${walletId}/reconcile`);
      expect(reconciled.status).toBe(200);
      // Same address as the first attempt — a second one would be a lost wallet.
      expect(reconciled.body.address).toBe(created.body.address);
      const conflicts = harness.upstream.requests.filter(
        (request) => request.path === "/v1/addresses" && request.method === "POST",
      );
      expect(conflicts.length).toBeGreaterThan(0);
    });

    it("finishes stuck wallets at boot", async () => {
      const created = await create({ externalId: "stuck-at-boot" });
      await harness.db.query("UPDATE wallets SET status = 'provisioning' WHERE id = $1", [
        created.body.id,
      ]);
      // A second container over the same database and the same upstream — a restart.
      const rebooted = await startHarness(
        { DATABASE_URL: (harness.db.options as { url: string }).url },
        { upstream: harness.upstream },
      );
      try {
        const wallet = await rebooted.wallets.findById(created.body.id as string);
        expect(wallet?.status).toBe("active");
      } finally {
        await rebooted.stop();
      }
    });
  });

  describe("reads", () => {
    it("finds a wallet by id and by external id", async () => {
      const created = await create({ externalId: "findable" });
      expect((await harness.get(`/v1/wallets/${created.body.id}`)).body.id).toBe(created.body.id);
      expect((await harness.get("/v1/wallets/by-external/FINDABLE")).body.id).toBe(created.body.id);
    });

    it("404s an unknown wallet and 400s a malformed id", async () => {
      expect((await harness.get("/v1/wallets/00000000-0000-4000-8000-000000000000")).status).toBe(
        404,
      );
      expect((await harness.get("/v1/wallets/nope")).status).toBe(400);
    });

    it("filters and pages", async () => {
      const page = await harness.get("/v1/wallets", { query: { kind: "user", limit: 2 } });
      expect(page.body.items).toHaveLength(2);
      expect(page.body.limit).toBe(2);
      expect(page.body.total).toBeGreaterThan(2);
    });

    it("searches by external id substring", async () => {
      const page = await harness.get("/v1/wallets", { query: { q: "findable" } });
      expect(page.body.total).toBe(1);
    });

    it("never exposes the stored row wholesale", async () => {
      const created = await create();
      const body = (await harness.get(`/v1/wallets/${created.body.id}`)).body;
      expect(body.derivationIndex).toBeUndefined();
    });
  });

  describe("dpm registration", () => {
    it("passes the attestation through without touching it", async () => {
      const created = await create();
      const response = await harness.post(`/v1/wallets/${created.body.id}/dpm-attestation`);
      expect(response.status).toBe(200);
      expect(response.body.address).toBe(created.body.address);
      expect(response.body.signature).toMatch(/^0x[0-9a-f]+1b$/);
    });

    it("mirrors the upstream flag rather than trusting the request", async () => {
      const created = await create();
      const response = await harness.post(`/v1/wallets/${created.body.id}/dpm-registered`, {
        body: { registered: true },
      });
      expect(response.body.dpmRegistered).toBe(true);
      expect((await harness.wallets.findById(created.body.id as string))?.dpmRegistered).toBe(true);
    });
  });

  describe("administration", () => {
    it("lets an admin disable a wallet, after which it cannot sign", async () => {
      const created = await create();
      const disabled = await harness.patch(`/v1/wallets/${created.body.id}`, {
        body: { status: "disabled" },
      });
      expect(disabled.body.status).toBe("disabled");

      const attempt = await harness.post(`/v1/wallets/${created.body.id}/dpm-attestation`);
      expect(attempt.status).toBe(409);
      expect(attempt.body.error.code).toBe("WALLET_DISABLED");
    });

    it("keeps a disabled wallet's address counted as ours", async () => {
      const disabled = (await harness.wallets.list({ status: "disabled" }, 1, 0)).wallets[0];
      // Funds may still sit there; forgetting it would turn an internal transfer into an external
      // one, which the funds policy would then refuse for the wrong reason.
      expect(await harness.wallets.isPlatformAddress(disabled?.proxyAddress ?? "")).toBe(true);
    });

    it("refuses an operator key on the admin-only patch", async () => {
      const created = await create();
      const response = await harness.patch(`/v1/wallets/${created.body.id}`, {
        body: { label: "renamed" },
        apiKey: harness.operatorKey,
      });
      expect(response.status).toBe(403);
    });
  });

  describe("idempotency", () => {
    it("replays the stored response instead of minting a second wallet", async () => {
      const first = await harness.post("/v1/wallets", {
        body: { externalId: "retried" },
        idempotencyKey: "retry-1",
      });
      const second = await harness.post("/v1/wallets", {
        body: { externalId: "retried" },
        idempotencyKey: "retry-1",
      });
      expect(second.status).toBe(201);
      expect(second.body.id).toBe(first.body.id);
      expect((await harness.wallets.list({ q: "retried" }, 10, 0)).total).toBe(1);
    });

    it("rejects the same key with a different body", async () => {
      const response = await harness.post("/v1/wallets", {
        body: { externalId: "different" },
        idempotencyKey: "retry-1",
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("IDEMPOTENCY_CONFLICT");
    });
  });
});
