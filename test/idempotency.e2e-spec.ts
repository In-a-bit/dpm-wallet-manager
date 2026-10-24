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

  it("forwards a key scoped to the actor, so dpm-wallet cannot replay one actor's response to another", async () => {
    const before = harness.upstream.requests.length;
    await sign(harness.adminKey, "fwd-key");
    await sign(harness.operatorKey, "fwd-key");
    const sent = harness.upstream.requests
      .slice(before)
      .filter((request) => request.path === "/v1/sign/order")
      .map((request) => request.headers["idempotency-key"]);
    expect(sent).toHaveLength(2);
    expect(sent[0]).toMatch(/^[0-9a-f]{16}:fwd-key:order$/);
    expect(sent[1]).toMatch(/^[0-9a-f]{16}:fwd-key:order$/);
    expect(sent[0]).not.toBe(sent[1]);
  });

  describe("across a key rotation", () => {
    const rotatedOperator = async (name: string) => {
      const created = (await harness.post("/v1/api-keys", { body: { role: "operator", name } }))
        .body;
      const rotation = await harness.post(`/v1/api-keys/${created.id}/rotate`, {
        body: { graceSeconds: 3600 },
      });
      return { before: created.key as string, after: rotation.body.created.key as string };
    };

    it("replays a retry made with the replacement credential", async () => {
      const { before, after } = await rotatedOperator("rot-replay");
      const first = await sign(before, "rot-key");
      const retry = await sign(after, "rot-key");
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(first.body);
    });

    it("merges the operation and reuses the upstream key even when the stored replay is gone", async () => {
      const { before, after } = await rotatedOperator("rot-merge");
      const first = await sign(before, "rot-merge-key");
      await harness.db.query(`DELETE FROM idempotency_keys`);
      const upstreamBefore = harness.upstream.requests.length;
      const retry = await sign(after, "rot-merge-key");
      expect(retry.body.operationId).toBe(first.body.operationId);
      const sent = harness.upstream.requests
        .slice(upstreamBefore)
        .filter((request) => request.path === "/v1/sign/order")
        .map((request) => request.headers["idempotency-key"]);
      expect(sent).toHaveLength(1);
    });

    it("terminates on a rotation cycle instead of spinning", async () => {
      const created = (
        await harness.post("/v1/api-keys", { body: { role: "operator", name: "rot-cycle" } })
      ).body;
      const rotation = await harness.post(`/v1/api-keys/${created.id}/rotate`, {
        body: { graceSeconds: 3600 },
      });
      // Nothing writes this; the query must survive it anyway.
      await harness.db.query(`UPDATE api_keys SET rotated_from_id = $1 WHERE id = $2`, [
        rotation.body.created.id,
        created.id,
      ]);

      const first = await sign(rotation.body.created.key as string, "rot-cycle-key");
      const retry = await sign(rotation.body.created.key as string, "rot-cycle-key");

      expect(first.status).toBe(200);
      expect(retry.status).toBe(200);
    });
  });

  it("accepts a 200-character key and refuses a longer one with 400", async () => {
    const ok = await sign(harness.adminKey, "k".repeat(200));
    const tooLong = await sign(harness.adminKey, "k".repeat(201));

    expect(ok.status).toBe(200);
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error.code).toBe("VALIDATION_FAILED");
  });
});
