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
