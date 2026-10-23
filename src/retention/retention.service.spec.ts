import { randomUUID } from "node:crypto";

import { loadConfig } from "../config";
import type { OperationKind } from "../db/entities";
import { AuditRepository } from "../db/repositories/audit.repo";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo";
import { OperationRepository } from "../db/repositories/operation.repo";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import { UiSessionRepository } from "../db/repositories/ui-session.repo";
import { AuditLog } from "../observability/audit";
import { RetentionSettingsService } from "../settings/retention-settings.service";
import { startDbFixture, type DbFixture } from "../testing/db-fixture";
import { testEnv } from "../testing/env";
import type { DpmWalletClient } from "../clients/dpm-wallet.client";
import { RETENTION_BATCH, RetentionService } from "./retention.service";

const DAY = 86_400_000;

describe("RetentionService", () => {
  let fixture: DbFixture;
  let operations: OperationRepository;
  let audit: AuditRepository;
  let idempotency: IdempotencyRepository;
  let sessions: UiSessionRepository;
  let settingsService: RetentionSettingsService;
  let purgeRoutineAudit: jest.Mock;
  let service: RetentionService;
  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY).toISOString();

  beforeAll(async () => {
    fixture = await startDbFixture();
    operations = new OperationRepository(fixture.db);
    audit = new AuditRepository(fixture.db);
    idempotency = new IdempotencyRepository(fixture.db);
    sessions = new UiSessionRepository(fixture.db);
    const config = loadConfig(testEnv({ DATABASE_URL: "postgres://unused/unused" }));
    settingsService = new RetentionSettingsService(
      new PlatformSettingsRepository(fixture.db),
      new AuditLog(audit),
      config,
      (work) => fixture.db.transaction(work),
    );
  });

  afterAll(async () => {
    await fixture.close();
  });

  afterEach(() => jest.restoreAllMocks());

  beforeEach(async () => {
    await fixture.db.query(
      `TRUNCATE operations, audit_events, idempotency_keys, ui_sessions, platform_settings RESTART IDENTITY`,
    );
    purgeRoutineAudit = jest.fn().mockResolvedValue({ deleted: 0 });
    service = new RetentionService(settingsService, operations, audit, idempotency, sessions, {
      purgeRoutineAudit,
    } as unknown as DpmWalletClient);
  });

  async function seedOp(kind: OperationKind, days: number, routed = false): Promise<void> {
    const walletId = randomUUID();
    await operations.insert({
      id: randomUUID(),
      walletId,
      signerWalletId: routed ? randomUUID() : walletId,
      kind,
      mode: "segregated",
      requestHash: "h",
      resultSummary: null,
      status: "ok",
      apiKeyId: null,
      uiUserId: null,
      createdAt: ago(days),
    });
  }

  async function seedAudit(action: string, outcome: string, days: number): Promise<void> {
    await audit.insert({
      actorKeyId: null,
      actorRole: null,
      actorUserId: null,
      actorUsername: null,
      walletId: null,
      action,
      outcome,
      detail: null,
      requestId: null,
      ip: null,
      createdAt: ago(days),
    });
  }

  const count = async (table: string): Promise<number> =>
    Number((await fixture.db.query(`SELECT count(*) AS n FROM ${table}`))[0].n);

  it("trims routine rows only, and a second run deletes nothing", async () => {
    await seedOp("order", 100); // direct, deleted
    await seedOp("order", 10); // direct, kept
    await seedOp("order", 200, true); // routed, kept
    await seedOp("order", 400, true); // routed, deleted
    await seedOp("withdraw", 1000);
    await seedOp("merge", 100); // deleted

    await seedAudit("sign.order", "success", 100); // deleted
    await seedAudit("sign.order", "denied", 100);
    await seedAudit("meta.withdraw", "success", 1000);
    await seedAudit("key.create", "success", 1000);

    await idempotency.save("old", { requestHash: "h", responseJson: "{}" }, ago(8));
    await idempotency.save("fresh", { requestHash: "h", responseJson: "{}" }, ago(1));
    for (const [expiresAt, id] of [
      [new Date(now.getTime() - 1000).toISOString(), randomUUID()],
      [new Date(now.getTime() + DAY).toISOString(), randomUUID()],
    ] as const) {
      await sessions.insert({
        id,
        tokenHash: id,
        userId: randomUUID(),
        createdAt: ago(2),
        lastSeenAt: ago(2),
        expiresAt,
        ip: null,
        userAgent: null,
      });
    }

    purgeRoutineAudit.mockResolvedValueOnce({ deleted: RETENTION_BATCH });
    purgeRoutineAudit.mockResolvedValueOnce({ deleted: 7 });

    const first = await service.runOnce(now);
    expect(first).toEqual({
      operations: 3,
      audit_events: 1,
      idempotency_keys: 1,
      ui_sessions: 1,
      dpm_wallet_audit_events: RETENTION_BATCH + 7,
    });
    expect(purgeRoutineAudit).toHaveBeenCalledTimes(2);
    for (const [before, batch] of purgeRoutineAudit.mock.calls as [string, number][]) {
      expect(Date.parse(before)).toBe(now.getTime() - 90 * DAY);
      expect(batch).toBe(RETENTION_BATCH);
    }
    expect(await count("operations")).toBe(3);
    expect(await count("audit_events")).toBe(3);
    expect(await count("idempotency_keys")).toBe(1);
    expect(await count("ui_sessions")).toBe(1);

    purgeRoutineAudit.mockClear();
    purgeRoutineAudit.mockResolvedValue({ deleted: 0 });
    expect(await service.runOnce(now)).toEqual({
      operations: 0,
      audit_events: 0,
      idempotency_keys: 0,
      ui_sessions: 0,
      dpm_wallet_audit_events: 0,
    });
  });

  it("deletes 12,001 routine operations in 3 batches", async () => {
    await fixture.db.query(
      `INSERT INTO operations (id, wallet_id, signer_wallet_id, kind, mode, request_hash, status, created_at)
       SELECT gen_random_uuid(), w, w, 'merge', 'segregated', 'h', 'ok', $1::timestamptz
       FROM (SELECT gen_random_uuid() AS w FROM generate_series(1, 12001)) s`,
      [ago(200)],
    );
    const spy = jest.spyOn(operations, "purgeRoutine");
    const counts = await service.runOnce(now);
    expect(counts.operations).toBe(12001);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(spy.mock.calls.every(([, , batch]) => batch === 5000)).toBe(true);
    expect(await count("operations")).toBe(0);
  });

  it("stops after 100 batches per table per run", async () => {
    const spy = jest.spyOn(operations, "purgeRoutine").mockResolvedValue(RETENTION_BATCH);
    purgeRoutineAudit.mockResolvedValue({ deleted: RETENTION_BATCH });
    const counts = await service.runOnce(now);
    expect(spy).toHaveBeenCalledTimes(100);
    expect(purgeRoutineAudit).toHaveBeenCalledTimes(100);
    expect(counts.operations).toBe(100 * RETENTION_BATCH);
  });

  it("logs retention.failed on a dpm-wallet error and still trims the manager tables", async () => {
    await seedOp("merge", 100);
    purgeRoutineAudit.mockRejectedValue(new Error("upstream down"));
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const original = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "debug";
    try {
      const counts = await service.runOnce(now);
      expect(counts.operations).toBe(1);
      expect(counts.dpm_wallet_audit_events).toBe(0);
      const lines = stderr.mock.calls.map(([line]) => String(line));
      expect(lines.some((line) => line.includes('"retention.failed"'))).toBe(true);
    } finally {
      stderr.mockRestore();
      if (original === undefined) delete process.env.LOG_LEVEL;
      else process.env.LOG_LEVEL = original;
    }
    expect(await count("operations")).toBe(0);
  });

  it("applies the dashboard cutoffs and the routineDaysOverride hook", async () => {
    await seedOp("merge", 40);
    await seedOp("merge", 20);
    await settingsService.update({ routineDays: 30 }, undefined);
    expect((await service.runOnce(now)).operations).toBe(1);

    await seedOp("merge", 10);
    service.routineDaysOverride = () => 7;
    expect((await service.runOnce(now)).operations).toBe(2);
    const cutoff = (purgeRoutineAudit.mock.calls.at(-1) as [string])[0];
    expect(Date.parse(cutoff)).toBe(now.getTime() - 7 * DAY);
  });

  it("keeps the partial count when a target fails mid-way", async () => {
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    purgeRoutineAudit
      .mockResolvedValueOnce({ deleted: RETENTION_BATCH })
      .mockRejectedValueOnce(new Error("upstream down"));
    const counts = await service.runOnce(now);
    expect(counts.dpm_wallet_audit_events).toBe(RETENTION_BATCH);
    stderr.mockRestore();
  });

  it("clamps routineDaysOverride to 1..configured routine days", async () => {
    await service.runOnce(now); // default 90
    service.routineDaysOverride = () => 0;
    await service.runOnce(now);
    expect(Date.parse((purgeRoutineAudit.mock.calls.at(-1) as [string])[0])).toBe(
      now.getTime() - 1 * DAY,
    );
    service.routineDaysOverride = () => -5;
    await service.runOnce(now);
    expect(Date.parse((purgeRoutineAudit.mock.calls.at(-1) as [string])[0])).toBe(
      now.getTime() - 1 * DAY,
    );
    service.routineDaysOverride = () => 500;
    await service.runOnce(now);
    expect(Date.parse((purgeRoutineAudit.mock.calls.at(-1) as [string])[0])).toBe(
      now.getTime() - 90 * DAY,
    );
  });

  it("stops after the batch in flight on destroy, quietly", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = jest.spyOn(operations, "purgeRoutine").mockImplementation(async () => {
      await gate;
      return RETENTION_BATCH;
    });
    const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
    const run = service.runOnce(now);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(spy).toHaveBeenCalledTimes(1);
    service.onModuleDestroy();
    release();
    const counts = await run;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(counts.operations).toBe(RETENTION_BATCH);
    expect(purgeRoutineAudit).not.toHaveBeenCalled();
    expect(stderr.mock.calls.some(([line]) => String(line).includes("retention.failed"))).toBe(
      false,
    );
    stderr.mockRestore();
  });

  it("does nothing when disabled, and its timers do nothing", async () => {
    await seedOp("merge", 100);
    await settingsService.update({ enabled: false }, undefined);
    expect(await service.runOnce(now)).toEqual({});
    expect(await count("operations")).toBe(1);
    expect(purgeRoutineAudit).not.toHaveBeenCalled();

    // The timers fire but delete nothing.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      jest.useRealTimers();
      await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      jest.useRealTimers();
      service.onModuleDestroy();
    }
    expect(await count("operations")).toBe(1);
    expect(purgeRoutineAudit).not.toHaveBeenCalled();
  });

  describe("scheduler", () => {
    afterEach(() => jest.useRealTimers());

    it("runs 60 s after start then hourly, never overlapping, and stops on destroy", async () => {
      jest.useFakeTimers();
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const run = jest.spyOn(service, "runOnce").mockImplementation(async () => {
        await gate;
        return {};
      });

      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(59_999);
      expect(run).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      expect(run).toHaveBeenCalledTimes(1);

      // Still running when the hourly tick is due: skipped.
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(run).toHaveBeenCalledTimes(1);

      release();
      await jest.advanceTimersByTimeAsync(3_600_000);
      expect(run).toHaveBeenCalledTimes(2);

      service.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(10 * 3_600_000);
      expect(run).toHaveBeenCalledTimes(2);
    });

    it("never throws out of the timer", async () => {
      jest.useFakeTimers();
      jest.spyOn(service, "runOnce").mockRejectedValue(new Error("boom"));
      const stderr = jest.spyOn(process.stderr, "write").mockImplementation(() => true);
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(60_000);
      expect(stderr.mock.calls.some(([line]) => String(line).includes('"retention.failed"'))).toBe(
        true,
      );
      stderr.mockRestore();
      service.onModuleDestroy();
    });
  });
});
