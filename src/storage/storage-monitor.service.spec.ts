import { randomUUID } from "node:crypto";

import { loadConfig } from "../config";
import type { DpmWalletClient } from "../clients/dpm-wallet.client";
import { AuditRepository } from "../db/repositories/audit.repo";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo";
import { OperationRepository } from "../db/repositories/operation.repo";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import { StorageSampleRepository } from "../db/repositories/storage-sample.repo";
import { UiSessionRepository } from "../db/repositories/ui-session.repo";
import { AuditLog } from "../observability/audit";
import { RetentionService } from "../retention/retention.service";
import { RetentionSettingsService } from "../settings/retention-settings.service";
import { StorageSettingsService } from "../settings/storage-settings.service";
import { startDbFixture, type DbFixture } from "../testing/db-fixture";
import { testEnv } from "../testing/env";
import { StorageMonitorService } from "./storage-monitor.service";

const DAY = 86_400_000;
const MIN = 60_000;
const SECRET_URL = "https://hooks.example.test/services/T000/SECRET-TOKEN";

describe("StorageMonitorService", () => {
  let fixture: DbFixture;
  let samples: StorageSampleRepository;
  let operations: OperationRepository;
  let audit: AuditRepository;
  let platformSettings: PlatformSettingsRepository;
  let storageSettings: StorageSettingsService;
  let retention: RetentionService;
  let monitor: StorageMonitorService;
  let usedPercent: number;
  let now: Date;
  let fetchImpl: jest.Mock;
  let lines: { event: string; [k: string]: unknown }[];
  let raw: string;

  const TOTAL = 100e9;
  const ago = (from: Date, days: number) => new Date(from.getTime() - days * DAY).toISOString();

  beforeAll(async () => {
    fixture = await startDbFixture();
    samples = new StorageSampleRepository(fixture.db);
    operations = new OperationRepository(fixture.db);
    audit = new AuditRepository(fixture.db);
    platformSettings = new PlatformSettingsRepository(fixture.db);
  });

  afterAll(async () => {
    await fixture.close();
  });

  beforeEach(async () => {
    await fixture.db.query(
      `TRUNCATE operations, audit_events, idempotency_keys, ui_sessions, platform_settings, storage_samples RESTART IDENTITY`,
    );
    const config = loadConfig(testEnv({ DATABASE_URL: "postgres://unused/unused" }));
    const auditLog = new AuditLog(audit);
    const retentionSettings = new RetentionSettingsService(
      platformSettings,
      auditLog,
      config,
      (work) => fixture.db.transaction(work),
    );
    storageSettings = new StorageSettingsService(platformSettings, auditLog, (work) =>
      fixture.db.transaction(work),
    );
    retention = new RetentionService(
      retentionSettings,
      operations,
      audit,
      new IdempotencyRepository(fixture.db),
      new UiSessionRepository(fixture.db),
      {
        purgeRoutineAudit: jest.fn().mockResolvedValue({ deleted: 0 }),
      } as unknown as DpmWalletClient,
      samples,
    );
    monitor = new StorageMonitorService(samples, storageSettings, retentionSettings, retention);
    now = new Date("2026-10-23T12:00:00Z");
    usedPercent = 50;
    monitor.clock = () => now;
    monitor.statfs = async () => ({
      totalBytes: TOTAL,
      freeBytes: Math.round(TOTAL * (1 - usedPercent / 100)),
    });
    fetchImpl = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    monitor.fetchImpl = fetchImpl;
    monitor.webhookTimeoutMs = 30;
    monitor.onModuleInit();
    monitor.onModuleDestroy(); // timers off; the hook stays wired
    (monitor as unknown as { stopped: boolean }).stopped = false;

    lines = [];
    raw = "";
    const capture = (chunk: unknown) => {
      raw += String(chunk);
      try {
        lines.push(JSON.parse(String(chunk)));
      } catch {
        // not a log line
      }
      return true;
    };
    jest.spyOn(process.stdout, "write").mockImplementation(capture);
    jest.spyOn(process.stderr, "write").mockImplementation(capture);
  });

  afterEach(() => jest.restoreAllMocks());

  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const events = (name: string) => lines.filter((l) => l.event === name);

  it("writes a sample on each timer fire", async () => {
    jest.useFakeTimers();
    try {
      const sampleOnce = jest.spyOn(monitor, "sampleOnce").mockResolvedValue(undefined);
      monitor.onModuleInit();
      await jest.advanceTimersByTimeAsync(20_000);
      expect(sampleOnce).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(15 * MIN);
      expect(sampleOnce).toHaveBeenCalledTimes(2);
      await jest.advanceTimersByTimeAsync(15 * MIN);
      expect(sampleOnce).toHaveBeenCalledTimes(3);
      monitor.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60 * MIN);
      expect(sampleOnce).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });

  it("stores the disk, database sizes and tables in each sample", async () => {
    await monitor.sampleOnce();
    advance(15 * MIN);
    await monitor.sampleOnce();
    const since = await samples.since(ago(now, 1));
    expect(since).toHaveLength(2);
    expect(since[1]).toMatchObject({
      diskTotalBytes: TOTAL,
      diskUsedPercent: 50,
      level: "ok",
      walletDbBytes: null,
    });
    expect(since[1]!.managerDbBytes).toBeGreaterThan(0);
    expect(since[1]!.tables.map((t) => t.name)).toEqual([
      "audit_events",
      "idempotency_keys",
      "operations",
    ]);
  });

  it("logs a level change and POSTs the webhook once, not again while it holds", async () => {
    await storageSettings.update({ alertWebhookUrl: SECRET_URL }, undefined);
    await monitor.sampleOnce();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(events("storage.level")).toHaveLength(0);

    usedPercent = 80;
    advance(15 * MIN);
    await monitor.sampleOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events("storage.level")).toHaveLength(1);
    expect(events("storage.level")[0]).toMatchObject({ level: "warning", previous: "ok" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(SECRET_URL);
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({
      install: "install",
      level: "warning",
      usedPercent: 80,
      daysToFull: null,
      at: now.toISOString(),
    });
    expect(JSON.parse(init.body).dbBytes).toBeGreaterThan(0);

    advance(15 * MIN);
    await monitor.sampleOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    usedPercent = 50;
    advance(15 * MIN);
    await monitor.sampleOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchImpl.mock.calls[1]![1].body).level).toBe("ok");
    expect(raw).not.toContain("SECRET-TOKEN");
  });

  it("re-POSTs while critical after 24 h, not before", async () => {
    await storageSettings.update({ alertWebhookUrl: SECRET_URL }, undefined);
    usedPercent = 95;
    await monitor.sampleOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(23 * 60 * MIN);
    await monitor.sampleOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    advance(60 * MIN);
    await monitor.sampleOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(events("storage.level")).toHaveLength(2);
  });

  it("does not POST without a webhook, and logs and survives a 500", async () => {
    usedPercent = 95;
    await monitor.sampleOnce();
    expect(fetchImpl).not.toHaveBeenCalled();

    await storageSettings.update({ alertWebhookUrl: SECRET_URL }, undefined);
    fetchImpl.mockResolvedValue({ ok: false, status: 500 });
    advance(24 * 60 * MIN);
    await expect(monitor.sampleOnce()).resolves.not.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(events("storage.webhook_failed")[0]).toMatchObject({ status: 500 });
    expect(raw).not.toContain("SECRET-TOKEN");
  });

  it("gives up on a hanging webhook after the timeout", async () => {
    await storageSettings.update({ alertWebhookUrl: SECRET_URL }, undefined);
    fetchImpl.mockImplementation(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    usedPercent = 95;
    await expect(monitor.sampleOnce()).resolves.not.toThrow();
    expect(events("storage.webhook_failed")).toHaveLength(1);
  });

  it("without a disk, logs storage.unavailable once and stays ok", async () => {
    monitor.statfs = async () => {
      throw new Error("ENOENT");
    };
    await monitor.sampleOnce();
    advance(15 * MIN);
    await monitor.sampleOnce();
    expect(events("storage.unavailable")).toHaveLength(1);
    const latest = await samples.latest();
    expect(latest).toMatchObject({ diskTotalBytes: null, level: "ok" });
    const view = await monitor.view();
    expect(view.disk).toBeNull();
    expect(view.level).toBe("ok");
  });

  it("the retention run trims samples older than 30 days", async () => {
    const base = {
      diskTotalBytes: null,
      diskFreeBytes: null,
      diskUsedPercent: null,
      walletDbBytes: null,
      managerDbBytes: 1,
      tables: [],
      growthBytesPerDay: null,
      daysToFull: null,
      level: "ok",
    };
    await samples.insert({ ...base, at: ago(now, 31) });
    await samples.insert({ ...base, at: ago(now, 29) });
    const counts = await retention.runOnce(now);
    expect(counts.storage_samples).toBe(1);
    expect(await samples.since(ago(now, 40))).toHaveLength(1);
  });

  describe("tightening", () => {
    const seedOp = async (kind: "order" | "withdraw", at: string) => {
      const walletId = randomUUID();
      await operations.insert({
        id: randomUUID(),
        walletId,
        signerWalletId: walletId,
        kind,
        mode: "segregated",
        requestHash: "h",
        resultSummary: null,
        status: "ok",
        apiKeyId: null,
        uiUserId: null,
        createdAt: at,
      });
    };
    const count = async (table: string) =>
      Number((await fixture.db.query(`SELECT count(*)::int AS n FROM ${table}`))[0].n);

    it("shortens to 30 days at critical, 7 after 24 h, and returns below warning", async () => {
      await seedOp("order", ago(now, 40));
      await seedOp("order", ago(now, 10));
      await seedOp("order", ago(now, 3));
      await seedOp("withdraw", ago(now, 400));
      await audit.insert({
        actorKeyId: null,
        actorRole: null,
        actorUserId: null,
        actorUsername: null,
        walletId: null,
        action: "sign.order",
        outcome: "denied",
        detail: null,
        requestId: null,
        ip: null,
        createdAt: ago(now, 400),
      });
      expect(await monitor.tightening()).toBeNull();

      usedPercent = 95;
      await monitor.sampleOnce();
      expect(events("retention.tightened")).toHaveLength(1);
      expect(events("retention.tightened")[0]).toMatchObject({ routineDays: 30 });
      expect(await monitor.tightening()).toMatchObject({
        routineDays: 30,
        since: now.toISOString(),
      });
      await retention.runOnce(now);
      expect(await count("operations")).toBe(3); // 40-day order gone; 10, 3 and the withdraw stay

      advance(24 * 60 * MIN);
      await monitor.sampleOnce();
      expect(events("retention.tightened")).toHaveLength(2);
      expect(events("retention.tightened")[1]).toMatchObject({ routineDays: 7 });
      await retention.runOnce(now);
      expect(await count("operations")).toBe(2); // 10-day order gone; the 4-day-old and withdraw stay

      usedPercent = 10;
      advance(15 * MIN);
      await monitor.sampleOnce();
      expect(events("retention.tightened")).toHaveLength(3);
      expect(events("retention.tightened")[2]).toMatchObject({ routineDays: null });
      expect(await monitor.tightening()).toBeNull();
      await seedOp("order", ago(now, 60));
      await retention.runOnce(now);
      expect(await count("operations")).toBe(3); // 60 days is inside the configured 90

      expect(
        Number(
          (
            await fixture.db.query(`SELECT count(*)::int n FROM operations WHERE kind='withdraw'`)
          )[0].n,
        ),
      ).toBe(1);
      expect(await count("audit_events")).toBeGreaterThanOrEqual(1);
      const denied = await fixture.db.query(`SELECT 1 FROM audit_events WHERE outcome='denied'`);
      expect(denied).toHaveLength(1);
    });

    it("warning after critical keeps the tightening; only ok lifts it", async () => {
      usedPercent = 95;
      await monitor.sampleOnce();
      usedPercent = 80;
      advance(15 * MIN);
      await monitor.sampleOnce();
      expect(await monitor.tightening()).toMatchObject({ routineDays: 30 });
      usedPercent = 50;
      advance(15 * MIN);
      await monitor.sampleOnce();
      expect(await monitor.tightening()).toBeNull();
    });

    it("does not report tightening when the configured days are already shorter", async () => {
      await platformSettings.set("retention.routine_days", "20", now.toISOString());
      usedPercent = 95;
      await monitor.sampleOnce();
      expect(await monitor.tightening()).toBeNull();
    });
  });
});
