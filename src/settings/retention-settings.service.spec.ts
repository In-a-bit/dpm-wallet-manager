import { loadConfig } from "../config";
import { startDbFixture, type DbFixture } from "../testing/db-fixture";
import { testEnv } from "../testing/env";
import { AuditRepository } from "../db/repositories/audit.repo";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import { AuditLog } from "../observability/audit";
import type { Actor } from "../common/actor";
import { ManagerError } from "../errors";
import { RetentionSettingsService } from "./retention-settings.service";

const actor: Actor = {
  keyId: null,
  userId: "11111111-1111-4111-8111-111111111111",
  username: "owner",
  role: "admin",
  prefix: "user:owner",
  name: "owner",
};

describe("RetentionSettingsService", () => {
  let fixture: DbFixture;
  let auditRepo: AuditRepository;
  let service: RetentionSettingsService;

  beforeAll(async () => {
    fixture = await startDbFixture();
    auditRepo = new AuditRepository(fixture.db);
    const config = loadConfig(testEnv({ DATABASE_URL: "postgres://unused/unused" }));
    service = new RetentionSettingsService(
      new PlatformSettingsRepository(fixture.db),
      new AuditLog(auditRepo),
      config,
      (work) => fixture.db.transaction(work),
    );
  });

  afterAll(async () => {
    await fixture.close();
  });

  it("reports the environment defaults with their sources", async () => {
    expect(await service.effective()).toEqual({
      enabled: true,
      routineDays: 90,
      routedOrderDays: 365,
      archiveReminderDays: 730,
      sources: {
        enabled: "environment",
        routineDays: "environment",
        routedOrderDays: "environment",
        archiveReminderDays: "default",
      },
    });
  });

  it("lets a dashboard value override the environment, and null revert it", async () => {
    await service.update({ routineDays: 30 }, actor);
    let effective = await service.effective();
    expect(effective.routineDays).toBe(30);
    expect(effective.sources.routineDays).toBe("dashboard");

    await service.update({ routineDays: null }, actor);
    effective = await service.effective();
    expect(effective.routineDays).toBe(90);
    expect(effective.sources.routineDays).toBe("environment");
  });

  it("stores enabled=false from the dashboard", async () => {
    await service.update({ enabled: false }, actor);
    const effective = await service.effective();
    expect(effective.enabled).toBe(false);
    expect(effective.sources.enabled).toBe("dashboard");
    await service.update({ enabled: null }, actor);
    expect((await service.effective()).enabled).toBe(true);
  });

  it("refuses a patch that puts routed below routine, and changes nothing", async () => {
    const err = await service.update({ routedOrderDays: 60 }, actor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagerError);
    expect((err as ManagerError).code).toBe("VALIDATION_FAILED");
    expect((await service.effective()).routedOrderDays).toBe(365);

    const err2 = await service.update({ routineDays: 400 }, actor).catch((e: unknown) => e);
    expect((err2 as ManagerError).code).toBe("VALIDATION_FAILED");
  });

  it("refuses a reminder below routine and out-of-range or fractional days", async () => {
    for (const patch of [
      { archiveReminderDays: 89 },
      { routineDays: 0 },
      { routineDays: 3651 },
      { routineDays: 1.5 },
    ]) {
      const err = await service.update(patch, actor).catch((e: unknown) => e);
      expect((err as ManagerError).code).toBe("VALIDATION_FAILED");
    }
  });

  it("audits an update with the old and new values", async () => {
    await service.update({ routineDays: 45, archiveReminderDays: 1000 }, actor);
    const page = await auditRepo.query({ action: "settings.retention_update" }, 10, 0);
    const event = page.events[0];
    expect(event?.outcome).toBe("success");
    expect(event?.actorUserId).toBe(actor.userId);
    expect(event?.detail).toMatchObject({
      before: { routineDays: 90, archiveReminderDays: 730 },
      after: { routineDays: 45, archiveReminderDays: 1000 },
    });
  });
});
