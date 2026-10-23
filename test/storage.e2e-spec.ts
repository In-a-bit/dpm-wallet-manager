import { StorageMonitorService } from "../src/storage/storage-monitor.service";
import { startHarness, type Harness } from "../src/testing/harness";

describe("storage", () => {
  let harness: Harness;
  let monitor: StorageMonitorService;

  beforeAll(async () => {
    harness = await startHarness();
    monitor = harness.app.get(StorageMonitorService);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("is readable by every role and has the documented shape", async () => {
    monitor.statfs = async () => ({ totalBytes: 100e9, freeBytes: 60e9 });
    await monitor.sampleOnce();
    for (const apiKey of [harness.readonlyKey, harness.operatorKey, harness.adminKey]) {
      const response = await harness.get("/v1/storage", { apiKey });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        at: expect.any(String),
        disk: { totalBytes: 100e9, freeBytes: 60e9, usedPercent: 40 },
        databases: { wallet: null, manager: expect.any(Number) },
        growthBytesPerDay: null,
        daysToFull: null,
        level: "ok",
        tightened: null,
        oldestImportantAt: expect.any(String),
        archiveSuggested: false,
      });
      expect(response.body.tables.map((t: { name: string }) => t.name)).toEqual([
        "audit_events",
        "idempotency_keys",
        "operations",
      ]);
      expect(response.body.tables[0]).toMatchObject({
        db: "manager",
        bytes: expect.any(Number),
        estRows: expect.any(Number),
      });
    }
    expect((await harness.get("/v1/storage", { apiKey: null })).status).toBe(401);
  });

  it("reports the oldest important record and suggests an archive when it is old", async () => {
    await harness.auditRepo.insert({
      actorKeyId: null,
      actorRole: null,
      actorUserId: null,
      actorUsername: null,
      walletId: null,
      action: "key.create",
      outcome: "success",
      detail: null,
      requestId: null,
      ip: null,
      createdAt: "2020-01-01T00:00:00.000Z",
    });
    await monitor.sampleOnce(); // the value is worked out per sample, not per request
    const body = (await harness.get("/v1/storage")).body;
    expect(body.oldestImportantAt).toBe("2020-01-01T00:00:00.000Z");
    expect(body.archiveSuggested).toBe(true);
  });

  it("/ready carries the storage field and stays 200 while critical", async () => {
    monitor.statfs = async () => ({ totalBytes: 100e9, freeBytes: 4e9 });
    await monitor.sampleOnce();
    const ready = await harness.get("/v1/health/ready", { apiKey: null });
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({
      status: "ok",
      storage: { level: "critical", usedPercent: 96, daysToFull: null },
    });
    const storage = (await harness.get("/v1/storage")).body;
    expect(storage.level).toBe("critical");
    expect(storage.tightened).toMatchObject({ routineDays: 30 });
  });
});
