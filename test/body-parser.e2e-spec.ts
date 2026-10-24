import { gzipSync } from "node:zlib";
import request from "supertest";

import { startHarness, type Harness } from "../src/testing/harness";

/** The body parser runs before auth, so a compressed body must be refused without being inflated. */
describe("request body encoding", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  it("rejects a gzip-encoded JSON body with 415", async () => {
    const response = await request(harness.app.getHttpServer())
      .post("/v1/wallets")
      .set("X-API-Key", harness.adminKey)
      .set("Content-Type", "application/json")
      .set("Content-Encoding", "gzip")
      .send(gzipSync(Buffer.from(JSON.stringify({ label: "x" }))));
    expect(response.status).toBe(415);
  });

  it("still accepts a plain JSON body", async () => {
    const response = await harness.post("/v1/wallets", { body: { label: "plain" } });
    expect(response.status).toBe(201);
  });

  it("answers malformed JSON with 400, not a 500", async () => {
    const response = await request(harness.app.getHttpServer())
      .post("/v1/wallets")
      .set("X-API-Key", harness.adminKey)
      .set("Content-Type", "application/json")
      .send('{"label": ');
    expect(response.status).toBe(400);
  });
});
