import { startHarness, type Harness } from "../src/testing/harness";

/**
 * The two history endpoints, exercised over a run that touches every kind of decision.
 *
 * The scenario is deliberately the whole story an operator would have to reconstruct after an
 * incident: keys minted, platform stood up, a wallet created, an order routed through the
 * treasury, a withdrawal refused, and the same withdrawal permitted from the master wallet.
 */
describe("audit and operations", () => {
  let harness: Harness;
  let userId: string;
  let masterId: string;
  let opsId: string;
  let orderHash: string;

  const EXTERNAL = "0x000000000000000000000000000000000000dEaD";

  beforeAll(async () => {
    harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
    masterId = (await harness.post("/v1/platform/master-wallet", { body: {} })).body.id;
    opsId = (await harness.post("/v1/platform/operations-wallet", { body: {} })).body.id;
    userId = (await harness.post("/v1/wallets", { body: { externalId: "trader" } })).body.id;
    for (const id of [masterId, opsId, userId]) {
      await harness.post(`/v1/wallets/${id}/dpm-registered`, { body: { registered: true } });
    }

    const order = await harness.post(`/v1/wallets/${userId}/orders/sign`, {
      body: {
        side: 0,
        tokenId: "713210456792522125946263855327069127503327285719",
        shares: 100,
        price: 0.4,
        feeRateBps: 200,
      },
    });
    orderHash = order.body.orderHash;

    // Refused, then permitted from the one wallet that may do it.
    await harness.post(`/v1/wallets/${userId}/withdraw`, {
      body: { recipient: EXTERNAL, amountDecimal: "5" },
      apiKey: harness.operatorKey,
    });
    await harness.post(`/v1/wallets/${masterId}/withdraw`, {
      body: { recipient: EXTERNAL, amountDecimal: "5" },
    });
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("the decision log", () => {
    it("holds the whole story, newest first", async () => {
      const response = await harness.get("/v1/audit", { query: { limit: 100 } });
      expect(response.status).toBe(200);
      const actions = response.body.items.map((item: { action: string }) => item.action);
      expect(actions).toEqual(
        expect.arrayContaining([
          "key.bootstrap",
          "platform.mode_burned",
          "platform.master_wallet_create",
          "platform.operations_wallet_create",
          "wallet.create",
          "wallet.dpm_registered",
          "sign.order",
          "meta.withdraw",
          "meta.withdraw.external",
        ]),
      );
      const timestamps = response.body.items.map((item: { createdAt: string }) => item.createdAt);
      expect([...timestamps].sort().reverse()).toEqual(timestamps);
    });

    it("keeps the refusal and the permitted transfer distinguishable", async () => {
      const denied = await harness.get("/v1/audit", { query: { outcome: "denied" } });
      expect(denied.body.total).toBe(1);
      expect(denied.body.items[0]).toMatchObject({ action: "meta.withdraw", walletId: userId });
      expect(denied.body.items[0].detail).toMatchObject({
        reason: "EXTERNAL_TRANSFER_FORBIDDEN",
        actorRole: "operator",
      });

      // The one action that means money left, on its own name so it can be alerted on.
      const external = await harness.get("/v1/audit", {
        query: { action: "meta.withdraw.external" },
      });
      expect(external.body.total).toBe(1);
      expect(external.body.items[0].walletId).toBe(masterId);
    });

    it("filters by wallet, by actor and by time", async () => {
      const byWallet = await harness.get("/v1/audit", { query: { walletId: userId } });
      expect(byWallet.body.total).toBeGreaterThan(0);
      expect(
        byWallet.body.items.every((item: { walletId: string }) => item.walletId === userId),
      ).toBe(true);

      const self = await harness.get("/v1/api-keys/self");
      const byActor = await harness.get("/v1/audit", { query: { actorKeyId: self.body.keyId } });
      expect(byActor.body.total).toBeGreaterThan(0);

      const future = await harness.get("/v1/audit", {
        query: { from: "2099-01-01T00:00:00Z" },
      });
      expect(future.body.total).toBe(0);
    });

    it("rejects an action nobody emits, rather than returning an empty page", async () => {
      const response = await harness.get("/v1/audit", { query: { action: "sign.orderr" } });
      expect(response.status).toBe(400);
    });

    it("never contains a credential", async () => {
      const response = await harness.get("/v1/audit", { query: { limit: 200 } });
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toContain(harness.adminKey);
      expect(serialised).not.toContain(harness.operatorKey);
      expect(serialised).not.toContain("upstream-test-key");
    });

    it("is readable by an operator, who has their own books to reconcile", async () => {
      const response = await harness.get("/v1/audit", { apiKey: harness.operatorKey });
      expect(response.status).toBe(200);
    });
  });

  describe("the artefact log", () => {
    it("answers which wallet signed the order behind a hash", async () => {
      const response = await harness.get("/v1/operations", { query: { kind: "order" } });
      const operation = response.body.items.find(
        (item: { resultSummary: string }) => item.resultSummary === orderHash,
      );
      // In shared mode the caller named the user, but the treasury signed — the decision log
      // alone could not tell you that.
      expect(operation).toMatchObject({ walletId: userId, signerWalletId: opsId, mode: "shared" });
    });

    it("filters by wallet and kind", async () => {
      const response = await harness.get("/v1/operations", {
        query: { walletId: masterId, kind: "withdraw" },
      });
      expect(response.body.total).toBe(1);
    });

    it("holds no signature, only a summary", async () => {
      const response = await harness.get("/v1/operations", { query: { limit: 100 } });
      const serialised = JSON.stringify(response.body);
      expect(serialised).not.toMatch(/"signature"/);
      expect(response.body.items[0].resultSummary).toBeDefined();
    });

    it("pages", async () => {
      const first = await harness.get("/v1/operations", { query: { limit: 1, offset: 0 } });
      const second = await harness.get("/v1/operations", { query: { limit: 1, offset: 1 } });
      expect(first.body.items).toHaveLength(1);
      expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
      expect(first.body.total).toBe(second.body.total);
    });

    it("rejects a limit past the cap", async () => {
      expect((await harness.get("/v1/operations", { query: { limit: 5000 } })).status).toBe(400);
    });
  });
});

describe("cursor paging", () => {
  let harness: Harness;
  // Every seeded row names this wallet, so a filter isolates them from the rows the boot wrote.
  const WALLET = "11111111-1111-4111-8111-111111111111";
  const BASE = Date.parse("2026-01-01T00:00:00.000Z");

  // Three rows share each timestamp, so only the id tie-break keeps the pages disjoint.
  const stamp = (i: number) => new Date(BASE + Math.floor(i / 3) * 1000).toISOString();

  const seedOperations = (from: number, to: number) =>
    harness.db.query(
      `INSERT INTO operations (id, wallet_id, signer_wallet_id, kind, mode, request_hash, status, created_at)
       SELECT gen_random_uuid(), $1, $1, 'order', 'segregated', 'h' || i, 'ok',
              to_timestamp($2::bigint / 1000.0 + (i / 3) )
       FROM generate_series($3::int, $4::int) AS i`,
      [WALLET, BASE, from, to - 1],
    );

  const seedAudit = (from: number, to: number) =>
    harness.db.query(
      `INSERT INTO audit_events (wallet_id, action, outcome, created_at)
       SELECT $1, 'sign.order', 'success', to_timestamp($2::bigint / 1000.0 + (i / 3))
       FROM generate_series($3::int, $4::int) AS i`,
      [WALLET, BASE, from, to - 1],
    );

  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(async () => {
    await harness.close();
  });

  const cases = [
    { name: "operations", path: "/v1/operations", seed: seedOperations },
    { name: "audit", path: "/v1/audit", seed: seedAudit },
  ];

  describe.each(cases)("$name", ({ path, seed }) => {
    const page = (query: Record<string, unknown>) =>
      harness.get(path, { query: { walletId: WALLET, ...query } });
    const ids = (body: { items: { id: string | number }[] }) => body.items.map((i) => i.id);

    beforeAll(async () => {
      await seed(0, 120);
    });

    it("pages 50/50/20 without overlap and without a total", async () => {
      const first = await page({ limit: 50 });
      expect(first.body.total).toBe(120);
      expect(first.body.items).toHaveLength(50);
      expect(typeof first.body.nextCursor).toBe("string");

      const second = await page({ limit: 50, cursor: first.body.nextCursor });
      const third = await page({ limit: 50, cursor: second.body.nextCursor });
      expect([second, third].map((r) => r.body.items.length)).toEqual([50, 20]);
      for (const r of [second, third]) expect("total" in r.body).toBe(false);
      expect(third.body.nextCursor).toBeNull();

      const all = [...ids(first.body), ...ids(second.body), ...ids(third.body)];
      expect(new Set(all).size).toBe(120);
      const times = [first, second, third].flatMap((r) =>
        r.body.items.map((i: { createdAt: string }) => i.createdAt),
      );
      expect([...times].sort().reverse()).toEqual(times);
      expect(first.body.items[0].createdAt).toBe(stamp(119));
    });

    it("is stable when newer rows arrive between pages", async () => {
      const original = await page({ limit: 100 });
      const first = await page({ limit: 50 });
      await seed(120, 125);
      const second = await page({ limit: 50, cursor: first.body.nextCursor });
      expect(ids(second.body)).toEqual(ids(original.body).slice(50, 100));
    });

    it("cursor=first is the newest page in cursor mode, with no total", async () => {
      const first = await page({ limit: 50, cursor: "first" });
      expect(first.status).toBe(200);
      expect("total" in first.body).toBe(false);
      expect(first.body.items).toHaveLength(50);
      expect(typeof first.body.nextCursor).toBe("string");

      const plain = await page({ limit: 100 });
      const second = await page({ limit: 50, cursor: first.body.nextCursor });
      expect("total" in second.body).toBe(false);
      expect([...ids(first.body), ...ids(second.body)]).toEqual(ids(plain.body));
    });

    it("keeps the offset mode, with its total", async () => {
      const response = await page({ limit: 10, offset: 5 });
      expect(response.body).toMatchObject({ limit: 10, offset: 5 });
      expect(response.body.total).toBeGreaterThanOrEqual(120);
      expect(typeof response.body.nextCursor).toBe("string");
    });

    it("answers INVALID_CURSOR to garbage", async () => {
      const response = await page({ cursor: "garbage" });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("INVALID_CURSOR");
    });

    it("answers INVALID_CURSOR to a well-formed cursor with the wrong kind of id", async () => {
      const cursor = Buffer.from(
        JSON.stringify({ createdAt: "2026-01-01T00:00:00.000Z", id: "not-an-id" }),
      ).toString("base64url");
      const response = await page({ cursor });
      expect(response.body.error.code).toBe("INVALID_CURSOR");
    });
  });
});
