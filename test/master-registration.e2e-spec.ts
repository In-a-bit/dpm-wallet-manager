import { startHarness, type Harness } from "../src/testing/harness";

const registrationCalls = (harness: Harness): string[] =>
  harness.upstream.requests
    .filter((request) => request.path.endsWith("/dpm-register"))
    .map((request) => request.path);

/**
 * The platform wallets move funds only by meta-transaction, which dpm-wallet refuses to sign (and
 * relayer-api to relay) until the DPM platform has registered the EOA. The master wallet is the
 * one exit; the operations wallet funds users in segregated mode and trades in shared. Leaving
 * their registration as a separate manual step meant either could be built and then found locked
 * at its first transfer, so provisioning does it.
 *
 * Ordinary user wallets keep the explicit attestation flow, because deciding when they join the
 * platform is an operator's call.
 */
describe("platform wallet registration", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
  });

  afterEach(async () => {
    await harness.close();
  });

  it("registers the master wallet with the DPM platform as it is created", async () => {
    const created = await harness.post("/v1/platform/master-wallet", { body: {} });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      kind: "master",
      status: "active",
      dpmRegistered: true,
    });
    expect(registrationCalls(harness)).toHaveLength(1);
  });

  it("registers the operations wallet with the DPM platform as it is created", async () => {
    const created = await harness.post("/v1/platform/operations-wallet", { body: {} });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({
      kind: "operations",
      status: "active",
      dpmRegistered: true,
    });
    expect(registrationCalls(harness)).toHaveLength(1);
  });

  // An install made before the operations wallet was registered automatically has an active,
  // unregistered one. Calling the idempotent create endpoint again is the repair.
  it("registers an existing unregistered operations wallet on the next create call", async () => {
    const created = await harness.post("/v1/platform/operations-wallet", { body: {} });
    await harness.post(`/v1/wallets/${created.body.id}/dpm-registered`, {
      body: { registered: false },
    });

    const again = await harness.post("/v1/platform/operations-wallet", { body: {} });

    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: created.body.id, dpmRegistered: true });
    expect(registrationCalls(harness)).toHaveLength(2);
  });

  it("leaves an ordinary wallet to be registered by an operator", async () => {
    const created = await harness.post("/v1/wallets", { body: { externalId: "customer-1" } });

    expect(created.status).toBe(201);
    expect(created.body.dpmRegistered).toBe(false);
    expect(registrationCalls(harness)).toHaveLength(0);
  });

  // An active master wallet that the platform has never heard of is the state worth preventing:
  // it looks usable, and fails at the first withdrawal. Holding it in `provisioning` instead
  // means every signing route already refuses it, with no new state to teach them about.
  it("does not activate the master wallet when registration fails", async () => {
    harness.upstream.failRegistrationWith = { status: 502, code: "RELAYER_REQUEST_FAILED" };

    const attempt = await harness.post("/v1/platform/master-wallet", { body: {} });
    expect(attempt.status).toBe(502);

    const status = await harness.get("/v1/platform");
    expect(status.body.masterWallet).toMatchObject({
      kind: "master",
      status: "provisioning",
      dpmRegistered: false,
    });
  });

  // The endpoint is already idempotent, so the retry an operator would reach for anyway is the
  // one that finishes the job — no separate repair call to know about.
  it("finishes a failed registration on the next call", async () => {
    harness.upstream.failRegistrationWith = { status: 502, code: "RELAYER_REQUEST_FAILED" };
    await harness.post("/v1/platform/master-wallet", { body: {} });

    harness.upstream.failRegistrationWith = undefined;
    const retry = await harness.post("/v1/platform/master-wallet", { body: {} });

    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: "active", dpmRegistered: true });
  });
});
