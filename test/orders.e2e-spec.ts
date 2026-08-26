import { startHarness, type Harness } from "../src/testing/harness";

/**
 * Order routing end to end, in both modes.
 *
 * The assertions deliberately reach past the HTTP response into the request the stand-in dpm-wallet
 * actually received: what matters is not what we told the caller we did, but which `ref`, `maker`
 * and `recipient` were put in front of the signing key.
 */
describe("orders", () => {
  const ORDER = {
    side: 0,
    tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
    shares: 100,
    price: 0.4,
    feeRateBps: 200,
  };

  const lastSignRequest = (harness: Harness) =>
    harness.upstream.requests.filter((request) => request.path === "/v1/sign/order").at(-1)?.body;

  describe("segregated mode", () => {
    let harness: Harness;
    let walletId: string;
    let proxyAddress: string;

    beforeAll(async () => {
      harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "segregated" });
      const created = await harness.post("/v1/wallets", { body: { externalId: "trader" } });
      walletId = created.body.id;
      proxyAddress = created.body.proxyAddress;
    });

    afterAll(async () => {
      await harness.close();
    });

    it.each([
      ["BUY", 0],
      ["SELL", 1],
    ])("has the wallet sign and make its own %s, with no recipient", async (_name, side) => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: { ...ORDER, side },
      });
      expect(response.status).toBe(200);
      expect(response.body.routing).toMatchObject({
        mode: "segregated",
        side,
        walletId,
        signerWalletId: walletId,
        maker: proxyAddress,
        recipient: null,
      });

      const sent = lastSignRequest(harness);
      expect(sent?.maker).toBe(proxyAddress);
      // Absent, not the zero address: the request says what it means.
      expect(sent).not.toHaveProperty("recipient");
    });

    it("returns the signed order untouched", async () => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, { body: ORDER });
      expect(response.body.order.maker).toBe(proxyAddress);
      expect(response.body.order.signer).toMatch(/^0x/);
      expect(response.body.signature).toMatch(/^0x/);
      expect(response.body.orderHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("records the operation with both wallets, which are the same here", async () => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, { body: ORDER });
      const operation = await harness.operations.findById(response.body.operationId as string);
      expect(operation).toMatchObject({
        walletId,
        signerWalletId: walletId,
        kind: "order",
        mode: "segregated",
        resultSummary: response.body.orderHash,
      });
    });

    it("rejects a price outside the unit interval and a non-numeric side", async () => {
      expect(
        (
          await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
            body: { ...ORDER, price: 1.5 },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
            body: { ...ORDER, side: "0" },
          })
        ).status,
      ).toBe(400);
    });

    it("ignores a caller-supplied maker or recipient", async () => {
      await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: {
          ...ORDER,
          maker: "0x000000000000000000000000000000000000dEaD",
          recipient: "0x000000000000000000000000000000000000dEaD",
        },
      });
      const sent = lastSignRequest(harness);
      // Stripped by the validation pipe's whitelist — routing is not negotiable.
      expect(sent?.maker).toBe(proxyAddress);
      expect(sent).not.toHaveProperty("recipient");
    });
  });

  describe("shared mode", () => {
    let harness: Harness;
    let walletId: string;
    let userProxy: string;
    let opsWalletId: string;
    let opsProxy: string;

    beforeAll(async () => {
      harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      const operations = await harness.post("/v1/platform/operations-wallet", { body: {} });
      opsWalletId = operations.body.id;
      opsProxy = operations.body.proxyAddress;
      const created = await harness.post("/v1/wallets", { body: { externalId: "trader" } });
      walletId = created.body.id;
      userProxy = created.body.proxyAddress;
    });

    afterAll(async () => {
      await harness.close();
    });

    it("has operations fund a BUY and pays the tokens to the user", async () => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: { ...ORDER, side: 0 },
      });
      expect(response.status).toBe(200);
      expect(response.body.routing).toMatchObject({
        mode: "shared",
        side: 0,
        walletId,
        signerWalletId: opsWalletId,
        maker: opsProxy,
        recipient: userProxy,
      });

      const sent = lastSignRequest(harness);
      // The treasury's ref selects the signing key, which is the whole mechanism.
      expect(sent?.ref).toBe(`mgr:${opsWalletId}`);
      expect(sent?.maker).toBe(opsProxy);
      expect(sent?.recipient).toBe(userProxy);
    });

    it("has the user fund a SELL and sweeps the collateral to operations", async () => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: { ...ORDER, side: 1 },
      });
      expect(response.body.routing).toMatchObject({
        signerWalletId: walletId,
        maker: userProxy,
        recipient: opsProxy,
      });
      const sent = lastSignRequest(harness);
      expect(sent?.ref).toBe(`mgr:${walletId}`);
      expect(sent?.recipient).toBe(opsProxy);
    });

    it("sends no recipient when the treasury trades for itself", async () => {
      const response = await harness.post(`/v1/wallets/${opsWalletId}/orders/sign`, {
        body: { ...ORDER, side: 0 },
      });
      expect(response.body.routing.recipient).toBeNull();
      expect(lastSignRequest(harness)).not.toHaveProperty("recipient");
    });

    it("records the operation against the user, with the treasury as signer", async () => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: { ...ORDER, side: 0 },
      });
      const operation = await harness.operations.findById(response.body.operationId as string);
      expect(operation).toMatchObject({ walletId, signerWalletId: opsWalletId, mode: "shared" });
    });

    it("refuses to sign when the treasury is disabled rather than naming a dead maker", async () => {
      await harness.patch(`/v1/wallets/${opsWalletId}`, { body: { status: "disabled" } });
      const response = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: { ...ORDER, side: 0 },
      });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("WALLET_DISABLED");
      await harness.patch(`/v1/wallets/${opsWalletId}`, { body: { status: "active" } });
    });
  });

  describe("shared mode without a treasury", () => {
    it("refuses to route rather than guessing", async () => {
      const harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      try {
        const created = await harness.post("/v1/wallets", { body: {} });
        const response = await harness.post(`/v1/wallets/${created.body.id}/orders/sign`, {
          body: ORDER,
        });
        expect(response.status).toBe(409);
        expect(response.body.error.code).toBe("OPERATIONS_WALLET_REQUIRED");
      } finally {
        await harness.close();
      }
    });
  });

  describe("the master wallet", () => {
    let harness: Harness;
    let masterId: string;

    beforeAll(async () => {
      harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "segregated" });
      masterId = (await harness.post("/v1/platform/master-wallet", { body: {} })).body.id;
    });

    afterAll(async () => {
      await harness.close();
    });

    it("cannot trade, because it deliberately has no allowance", async () => {
      const response = await harness.post(`/v1/wallets/${masterId}/orders/sign`, { body: ORDER });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("MASTER_WALLET_CANNOT_TRADE");
    });

    it("records the refusal", async () => {
      const page = await harness.auditRepo.query({ outcome: "denied" }, 10, 0);
      expect(
        page.events.some((event) => event.detail?.reason === "MASTER_WALLET_CANNOT_TRADE"),
      ).toBe(true);
    });

    it("never reaches the upstream", async () => {
      const before = harness.upstream.requests.length;
      await harness.post(`/v1/wallets/${masterId}/orders/sign`, { body: ORDER });
      expect(harness.upstream.requests.length).toBe(before);
    });
  });

  describe("cancels", () => {
    let harness: Harness;
    let walletId: string;
    let opsWalletId: string;

    beforeAll(async () => {
      harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      opsWalletId = (await harness.post("/v1/platform/operations-wallet", { body: {} })).body.id;
      walletId = (await harness.post("/v1/wallets", { body: {} })).body.id;
    });

    afterAll(async () => {
      await harness.close();
    });

    it("is signed by whoever signed the order, not by the wallet named", async () => {
      const order = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
        body: { ...ORDER, side: 0 },
      });
      const cancel = await harness.post(`/v1/wallets/${walletId}/orders/cancel`, {
        body: { orderHash: order.body.orderHash, marketId: "market-1" },
      });
      expect(cancel.status).toBe(200);
      // The BUY was signed by the treasury, so the cancel must be too.
      expect(cancel.body.signerWalletId).toBe(opsWalletId);
      const sent = harness.upstream.requests
        .filter((request) => request.path === "/v1/sign/cancel")
        .at(-1)?.body;
      expect(sent?.ref).toBe(`mgr:${opsWalletId}`);
    });

    it("falls back to the named wallet for an order this install did not sign", async () => {
      const cancel = await harness.post(`/v1/wallets/${walletId}/orders/cancel`, {
        body: { orderHash: `0x${"ab".repeat(32)}`, marketId: "market-1" },
      });
      expect(cancel.status).toBe(200);
      expect(cancel.body.signerWalletId).toBe(walletId);
    });

    it("rejects a malformed order hash", async () => {
      const response = await harness.post(`/v1/wallets/${walletId}/orders/cancel`, {
        body: { orderHash: "0xabc", marketId: "market-1" },
      });
      expect(response.status).toBe(400);
    });
  });

  describe("idempotency", () => {
    it("replays rather than producing a second signature", async () => {
      const harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "segregated" });
      try {
        const walletId = (await harness.post("/v1/wallets", { body: {} })).body.id;
        const first = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
          body: ORDER,
          idempotencyKey: "trade-1",
        });
        const second = await harness.post(`/v1/wallets/${walletId}/orders/sign`, {
          body: ORDER,
          idempotencyKey: "trade-1",
        });
        expect(second.body).toEqual(first.body);
        expect((await harness.operations.query({ kind: "order" }, 10, 0)).total).toBe(1);
      } finally {
        await harness.close();
      }
    });
  });
});
