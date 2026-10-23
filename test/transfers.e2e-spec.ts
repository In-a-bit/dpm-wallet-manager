import { startHarness, type Harness } from "../src/testing/harness";

const EXTERNAL = "0x000000000000000000000000000000000000dEaD";

/**
 * Transfers end to end: the withdrawal is built exactly as `/withdraw` builds it — same policy,
 * same signature — and then relayed through dpm-wallet rather than handed back.
 *
 * What these prove is that the policy still runs first (a refusal never reaches the relay), that
 * what is relayed is the signed body and nothing of ours, and that the relayer's id is kept on
 * the operation so its status can be looked up later.
 */
describe("transfers", () => {
  let harness: Harness;
  let masterId: string;
  let opsId: string;
  let masterEoa: string;

  const relays = () => harness.upstream.requests.filter((r) => r.path === "/v1/relay");

  beforeAll(async () => {
    harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
    masterId = (await harness.post("/v1/platform/master-wallet", { body: {} })).body.id;
    opsId = (await harness.post("/v1/platform/operations-wallet", { body: {} })).body.id;
    for (const id of [masterId, opsId]) {
      await harness.post(`/v1/wallets/${id}/dpm-registered`, { body: { registered: true } });
    }
    masterEoa = (await harness.get(`/v1/wallets/${masterId}`)).body.address;
  });

  beforeEach(() => {
    harness.upstream.requests.length = 0;
  });

  afterAll(async () => {
    await harness.close();
  });

  it("signs and relays an internal transfer with an operator key", async () => {
    harness.upstream.relayTransactionId = "relay-internal-1";
    harness.upstream.relayState = "STATE_NEW";

    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "25" },
      apiKey: harness.operatorKey,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      operationId: expect.any(String),
      relayerTransactionId: "relay-internal-1",
      state: "STATE_NEW",
      external: false,
    });
    expect(relays()).toHaveLength(1);
    expect(relays()[0]?.body?.from).toBe(masterEoa);
  });

  it("relays the signed body verbatim, without the manager's own fields", async () => {
    await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "1" },
      apiKey: harness.operatorKey,
    });
    expect(harness.upstream.lastSigned).toBeDefined();
    expect(relays()[0]?.body).toEqual(harness.upstream.lastSigned);
    expect(relays()[0]?.body).not.toHaveProperty("walletId");
    expect(relays()[0]?.body).not.toHaveProperty("operationId");
    expect(relays()[0]?.body).not.toHaveProperty("external");
  });

  it("keeps the relayer id on the operation", async () => {
    harness.upstream.relayTransactionId = "relay-kept-1";
    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "2" },
      apiKey: harness.operatorKey,
    });
    const page = await harness.get(`/v1/operations?walletId=${masterId}&kind=withdraw`);
    const operation = (page.body.items as { id: string }[]).find(
      (item) => item.id === response.body.operationId,
    );
    expect(operation).toMatchObject({ relayerTransactionId: "relay-kept-1", status: "signed" });
  });

  it("accepts the relayer's snake_case spelling of the id", async () => {
    harness.upstream.relayTransactionId = "relay-snake-1";
    harness.upstream.relaySnakeCase = true;
    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "3" },
      apiKey: harness.operatorKey,
    });
    harness.upstream.relaySnakeCase = false;
    expect(response.status).toBe(200);
    expect(response.body.relayerTransactionId).toBe("relay-snake-1");
  });

  it("reports a relayed transfer's status, looked up with the signer's EOA", async () => {
    harness.upstream.relayTransactionId = "relay-status-1";
    await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "4" },
      apiKey: harness.operatorKey,
    });
    harness.upstream.relayStatusState = "STATE_MINED";
    harness.upstream.relayStatusHash = `0x${"ab".repeat(32)}`;

    const response = await harness.get("/v1/transfers/relay-status-1", {
      apiKey: harness.readonlyKey,
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      relayerTransactionId: "relay-status-1",
      state: "STATE_MINED",
      transactionHash: `0x${"ab".repeat(32)}`,
    });
    const lookup = harness.upstream.requests.find((r) => r.path.startsWith("/v1/relay/"));
    expect(lookup?.path).toBe(`/v1/relay/relay-status-1?from=${masterEoa}`);
  });

  it("reports a null hash while the relayer has none", async () => {
    harness.upstream.relayTransactionId = "relay-nohash-1";
    await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "4" },
      apiKey: harness.operatorKey,
    });
    harness.upstream.relayStatusState = "STATE_NEW";
    harness.upstream.relayStatusHash = null;

    const response = await harness.get("/v1/transfers/relay-nohash-1");
    expect(response.status).toBe(200);
    expect(response.body.transactionHash).toBeNull();
  });

  it("refuses an external transfer from the master wallet with an operator key, before relaying", async () => {
    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipient: EXTERNAL, amountDecimal: "5" },
      apiKey: harness.operatorKey,
    });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe("EXTERNAL_TRANSFER_FORBIDDEN");
    expect(relays()).toHaveLength(0);
  });

  it("relays an external transfer from the master wallet with an admin key", async () => {
    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipient: EXTERNAL, amountDecimal: "5" },
      apiKey: harness.adminKey,
    });
    expect(response.status).toBe(200);
    expect(response.body.external).toBe(true);
    expect(relays()).toHaveLength(1);
  });

  it("refuses a readonly key", async () => {
    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "1" },
      apiKey: harness.readonlyKey,
    });
    expect(response.status).toBe(403);
    expect(relays()).toHaveLength(0);
  });

  it("answers 404 for a relayer id it never issued", async () => {
    const response = await harness.get("/v1/transfers/never-issued");
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("TRANSFER_NOT_FOUND");
  });

  it("keeps the signed operation when the relay fails, and surfaces the error", async () => {
    harness.upstream.failRelayWith = { status: 502, code: "RELAYER_REQUEST_FAILED" };
    const response = await harness.post(`/v1/wallets/${masterId}/transfers`, {
      body: { recipientWalletId: opsId, amountDecimal: "6.5" },
      apiKey: harness.operatorKey,
    });
    harness.upstream.failRelayWith = undefined;

    expect(response.status).toBe(502);
    expect(response.body.error.details.upstream).toBe("RELAYER_REQUEST_FAILED");
    const page = await harness.get(`/v1/operations?walletId=${masterId}&kind=withdraw&limit=1`);
    expect(page.body.items[0]).toMatchObject({ status: "signed", relayerTransactionId: null });
  });
});
