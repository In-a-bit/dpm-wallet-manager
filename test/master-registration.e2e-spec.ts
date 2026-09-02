import { startHarness, type Harness } from "../src/testing/harness";

const registrationCalls = (harness: Harness): string[] =>
  harness.upstream.requests
    .filter((request) => request.path.endsWith("/dpm-register"))
    .map((request) => request.path);

/**
 * The master wallet is the one place USDC leaves the platform, and every withdrawal from it is a
 * meta-transaction — which dpm-wallet refuses to sign until the DPM platform has registered the
 * EOA. Leaving that as a separate manual step meant the exit door could be built and then found
 * locked at the worst possible moment, so provisioning does it.
 *
 * Nothing else changes: the operations wallet and ordinary user wallets keep the explicit
 * attestation flow, because deciding when they join the platform is an operator's call.
 */
describe("master wallet registration", () => {
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

  it("leaves the operations wallet to be registered by an operator", async () => {
    const created = await harness.post("/v1/platform/operations-wallet", { body: {} });

    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ kind: "operations", dpmRegistered: false });
    expect(registrationCalls(harness)).toHaveLength(0);
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
