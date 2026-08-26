import { startHarness, type Harness } from "../src/testing/harness";

const CONDITION_ID = `0x${"7a".repeat(32)}`;
const EXTERNAL = "0x000000000000000000000000000000000000dEaD";

/**
 * Meta-transactions end to end, with the funds policy actually in the path.
 *
 * The policy's own table is covered by its unit spec; what these prove is that every route reaches
 * it, that a refusal happens *before* anything is signed, and that the returned body is the
 * upstream's own submit-ready envelope rather than something reshaped here.
 */
describe("meta-transactions", () => {
  let harness: Harness;
  let userId: string;
  let masterId: string;
  let opsId: string;

  const register = async (id: string) => {
    await harness.post(`/v1/wallets/${id}/dpm-registered`, { body: { registered: true } });
  };

  beforeAll(async () => {
    harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
    masterId = (await harness.post("/v1/platform/master-wallet", { body: {} })).body.id;
    opsId = (await harness.post("/v1/platform/operations-wallet", { body: {} })).body.id;
    userId = (await harness.post("/v1/wallets", { body: { externalId: "trader" } })).body.id;
    for (const id of [masterId, opsId, userId]) await register(id);
  });

  afterAll(async () => {
    await harness.close();
  });

  describe("the non-transferring kinds", () => {
    it("returns the upstream's submit-ready body verbatim", async () => {
      const response = await harness.post(`/v1/wallets/${userId}/allowance`);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        type: "PROXY",
        nonce: "0",
        walletId: userId,
        external: false,
      });
      expect(response.body.from).toMatch(/^0x/);
      expect(response.body.signature).toMatch(/^0x/);
      expect(response.body.signatureParams).toBeDefined();
    });

    it.each([
      ["split", { conditionId: CONDITION_ID, amountDecimal: "10.5" }],
      ["merge", { conditionId: CONDITION_ID, amountDecimal: "10.5" }],
      ["redeem", { conditionId: CONDITION_ID }],
    ])("signs a %s", async (kind, body) => {
      const response = await harness.post(`/v1/wallets/${userId}/${kind}`, { body });
      expect(response.status).toBe(200);
      expect(response.body.external).toBe(false);
    });

    it("passes the arguments through unchanged", async () => {
      await harness.post(`/v1/wallets/${userId}/split`, {
        body: { conditionId: CONDITION_ID, amountDecimal: "10.5" },
      });
      const sent = harness.upstream.requests.filter((r) => r.path === "/v1/meta-tx/split").at(-1);
      expect(sent?.body).toEqual({
        ref: `mgr:${userId}`,
        conditionId: CONDITION_ID,
        amountDecimal: "10.5",
      });
    });

    it("rejects a malformed condition id and a negative amount", async () => {
      expect(
        (
          await harness.post(`/v1/wallets/${userId}/split`, {
            body: { conditionId: "0xdead", amountDecimal: "1" },
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await harness.post(`/v1/wallets/${userId}/split`, {
            body: { conditionId: CONDITION_ID, amountDecimal: "-1" },
          })
        ).status,
      ).toBe(400);
    });

    it("refuses an allowance for the master wallet", async () => {
      const response = await harness.post(`/v1/wallets/${masterId}/allowance`);
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("MASTER_ALLOWANCE_FORBIDDEN");
    });
  });

  describe("internal transfers", () => {
    it("are allowed to another wallet's address with an operator key", async () => {
      const ops = await harness.get(`/v1/wallets/${opsId}`);
      const response = await harness.post(`/v1/wallets/${userId}/withdraw`, {
        body: { recipient: ops.body.proxyAddress, amountDecimal: "25" },
        apiKey: harness.operatorKey,
      });
      expect(response.status).toBe(200);
      expect(response.body.external).toBe(false);
    });

    it("accept a wallet id instead of an address, resolving to its proxy", async () => {
      const response = await harness.post(`/v1/wallets/${opsId}/withdraw`, {
        body: { recipientWalletId: masterId, amountDecimal: "1000" },
        apiKey: harness.operatorKey,
      });
      expect(response.status).toBe(200);

      const master = await harness.get(`/v1/wallets/${masterId}`);
      const sent = harness.upstream.requests
        .filter((r) => r.path === "/v1/meta-tx/withdraw")
        .at(-1);
      // The proxy, not the EOA: funds live at the proxy, and paying the EOA would strand them.
      expect(sent?.body?.recipient).toBe(master.body.proxyAddress);
      expect(sent?.body?.recipient).not.toBe(master.body.address);
    });

    it("reject both recipient forms at once", async () => {
      const response = await harness.post(`/v1/wallets/${userId}/withdraw`, {
        body: { recipient: EXTERNAL, recipientWalletId: masterId, amountDecimal: "1" },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.message).toMatch(/not both/);
    });

    it("reject a withdrawal with no destination at all", async () => {
      const response = await harness.post(`/v1/wallets/${userId}/withdraw`, {
        body: { amountDecimal: "1" },
      });
      expect(response.status).toBe(400);
    });
  });

  describe("external transfers", () => {
    it("are refused from a user wallet, whatever the key", async () => {
      for (const apiKey of [harness.operatorKey, harness.adminKey]) {
        const response = await harness.post(`/v1/wallets/${userId}/withdraw`, {
          body: { recipient: EXTERNAL, amountDecimal: "5" },
          apiKey,
        });
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe("EXTERNAL_TRANSFER_FORBIDDEN");
      }
    });

    it("are refused from the treasury", async () => {
      const response = await harness.post(`/v1/wallets/${opsId}/withdraw`, {
        body: { recipient: EXTERNAL, amountDecimal: "5" },
      });
      expect(response.status).toBe(403);
    });

    it("are refused from the master wallet with an operator key", async () => {
      const response = await harness.post(`/v1/wallets/${masterId}/withdraw`, {
        body: { recipient: EXTERNAL, amountDecimal: "5" },
        apiKey: harness.operatorKey,
      });
      expect(response.status).toBe(403);
      expect(response.body.error.message).toMatch(/admin key/);
    });

    it("never reach the upstream when refused, so no signature is ever produced", async () => {
      const before = harness.upstream.requests.length;
      await harness.post(`/v1/wallets/${userId}/withdraw`, {
        body: { recipient: EXTERNAL, amountDecimal: "5" },
      });
      expect(harness.upstream.requests.length).toBe(before);
    });

    it("succeed from the master wallet with an admin key", async () => {
      const response = await harness.post(`/v1/wallets/${masterId}/withdraw`, {
        body: { recipient: EXTERNAL, amountDecimal: "5" },
      });
      expect(response.status).toBe(200);
      expect(response.body.external).toBe(true);
      expect(response.body.type).toBe("PROXY");
    });

    it("are recorded under their own audit action", async () => {
      const page = await harness.auditRepo.query({ action: "meta.withdraw.external" }, 10, 0);
      expect(page.total).toBeGreaterThan(0);
      expect(page.events[0]).toMatchObject({ actorRole: "admin", walletId: masterId });
      expect(page.events[0]?.detail).toMatchObject({ recipient: EXTERNAL });
    });

    it("apply the same rule to a redeem that forwards its payout outside", async () => {
      const refused = await harness.post(`/v1/wallets/${userId}/redeem`, {
        body: { conditionId: CONDITION_ID, recipient: EXTERNAL },
      });
      expect(refused.status).toBe(403);

      const allowed = await harness.post(`/v1/wallets/${masterId}/redeem`, {
        body: { conditionId: CONDITION_ID, recipient: EXTERNAL },
      });
      expect(allowed.status).toBe(200);
      expect(allowed.body.external).toBe(true);
    });
  });

  describe("preconditions", () => {
    it("surfaces an unregistered wallet as its own code rather than a generic upstream failure", async () => {
      const fresh = (await harness.post("/v1/wallets", { body: {} })).body.id;
      const response = await harness.post(`/v1/wallets/${fresh}/allowance`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("WALLET_NOT_REGISTERED");
      expect(response.body.error.details).toMatchObject({ upstream: "CUSTOMER_NOT_REGISTERED" });
    });

    it("refuses a disabled wallet before reaching the policy", async () => {
      const disabled = (await harness.post("/v1/wallets", { body: {} })).body.id;
      await harness.patch(`/v1/wallets/${disabled}`, { body: { status: "disabled" } });
      const response = await harness.post(`/v1/wallets/${disabled}/allowance`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("WALLET_DISABLED");
    });
  });

  describe("bookkeeping", () => {
    it("records every signed meta-transaction against its wallet", async () => {
      const page = await harness.operations.query({ walletId: masterId }, 50, 0);
      expect(page.operations.some((operation) => operation.kind === "withdraw")).toBe(true);
      expect(page.operations.every((operation) => operation.signerWalletId === masterId)).toBe(
        true,
      );
    });

    it("replays a retried request instead of signing twice", async () => {
      const body = { conditionId: CONDITION_ID, amountDecimal: "3" };
      const first = await harness.post(`/v1/wallets/${userId}/merge`, {
        body,
        idempotencyKey: "merge-1",
      });
      const second = await harness.post(`/v1/wallets/${userId}/merge`, {
        body,
        idempotencyKey: "merge-1",
      });
      expect(second.body.operationId).toBe(first.body.operationId);
    });
  });
});
