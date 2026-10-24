import { IdempotencyRepository } from "../src/db/repositories/idempotency.repo";
import { startHarness, type Harness } from "../src/testing/harness";

const ORDER = {
  side: 0,
  tokenId: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  shares: 100,
  price: 0.4,
  feeRateBps: 200,
};

/** Idempotency is opt-in per route and scoped to the caller that used the key. */
describe("idempotency", () => {
  let harness: Harness;
  let walletId: string;
  let repo: IdempotencyRepository;
  const sign = (apiKey: string, idempotencyKey: string) =>
    harness.post(`/v1/wallets/${walletId}/orders/sign`, {
      body: ORDER,
      apiKey,
      idempotencyKey,
    });
  const stored = async () =>
    Number((await harness.db.query(`SELECT count(*) FROM idempotency_keys`))[0].count);

  beforeAll(async () => {
    harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "segregated" });
    walletId = (await harness.post("/v1/wallets", { body: {} })).body.id;
    repo = harness.app.get(IdempotencyRepository);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("does not let another actor replay a key: it is a fresh key for them", async () => {
    const mine = await sign(harness.adminKey, "shared-key");
    const replay = await sign(harness.adminKey, "shared-key");
    expect(replay.body).toEqual(mine.body);

    const theirs = await sign(harness.operatorKey, "shared-key");
    expect(theirs.status).toBe(200);
    expect(theirs.body.operationId).not.toBe(mine.body.operationId);
  });

  it("stores nothing for a GET that carries a key", async () => {
    const before = await stored();
    const response = await harness.get("/v1/wallets", { headers: { "Idempotency-Key": "k-get" } });
    expect(response.status).toBe(200);
    expect(await stored()).toBe(before);
  });

  it("never stores the api-keys responses, so a key-bearing create is not replayed", async () => {
    const before = await stored();
    const create = () =>
      harness.post("/v1/api-keys", {
        body: { role: "readonly", name: "idem" },
        idempotencyKey: "k-keys",
      });
    const first = await create();
    const second = await create();
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).not.toBe(first.body.id);
    expect(second.body.key).not.toBe(first.body.key);
    expect(await stored()).toBe(before);
  });

  it("honours a key for 24 hours only", async () => {
    const record = { requestHash: "h", responseJson: "{}" };
    const now = new Date();
    await repo.save("a", "old", record, new Date(now.getTime() - 25 * 3600_000).toISOString());
    await repo.save("a", "fresh", record, new Date(now.getTime() - 23 * 3600_000).toISOString());
    expect(await repo.find("a", "old", now)).toBeUndefined();
    expect(await repo.find("a", "fresh", now)).toEqual(record);
    expect(await repo.find("b", "fresh", now)).toBeUndefined();
    // An expired key can be used again.
    await repo.save("a", "old", { requestHash: "h2", responseJson: "{}" }, now.toISOString());
    expect((await repo.find("a", "old", now))?.requestHash).toBe("h2");
  });
});
