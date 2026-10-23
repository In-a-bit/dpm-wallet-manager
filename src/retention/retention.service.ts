import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import { AuditRepository } from "../db/repositories/audit.repo";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo";
import { OperationRepository } from "../db/repositories/operation.repo";
import { UiSessionRepository } from "../db/repositories/ui-session.repo";
import { logError, logInfo } from "../observability/log";
import { RetentionSettingsService } from "../settings/retention-settings.service";

export const RETENTION_BATCH = 5000;
export const RETENTION_MAX_BATCHES = 100;
const FIRST_RUN_MS = 60_000;
const INTERVAL_MS = 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Background trimming of routine records, in this service and in dpm-wallet.
 *
 * The first run is 60 s after start (so boot is not slowed), then hourly. Settings are read at the
 * start of each run, so a dashboard change applies to the next one. Important records (withdraws,
 * denials, key and user events) are never touched here; only an archive the operator confirmed
 * deletes them.
 */
@Injectable()
export class RetentionService implements OnModuleInit, OnModuleDestroy {
  /**
   * Replaces the routine days when it returns a number: how storage-pressure tightening shortens
   * retention without changing the configured value.
   */
  routineDaysOverride: (() => number | undefined) | undefined;

  private firstRun: NodeJS.Timeout | undefined;
  private hourly: NodeJS.Timeout | undefined;
  private running = false;

  constructor(
    private readonly settings: RetentionSettingsService,
    private readonly operations: OperationRepository,
    private readonly audit: AuditRepository,
    private readonly idempotency: IdempotencyRepository,
    private readonly sessions: UiSessionRepository,
    private readonly upstream: DpmWalletClient,
  ) {}

  onModuleInit(): void {
    // unref: the timers must never be what keeps a process (or a test run) alive.
    this.firstRun = setTimeout(() => {
      void this.tick();
      this.hourly = setInterval(() => void this.tick(), INTERVAL_MS);
      this.hourly.unref();
    }, FIRST_RUN_MS);
    this.firstRun.unref();
  }

  onModuleDestroy(): void {
    clearTimeout(this.firstRun);
    clearInterval(this.hourly);
    this.firstRun = undefined;
    this.hourly = undefined;
  }

  /** One timer fire: skipped while a run is still going, and never throws. */
  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      logError("retention.failed", { stage: "run", err });
    } finally {
      this.running = false;
    }
  }

  /**
   * Trims once and returns the rows deleted per table. Returns `{}` while retention is disabled.
   * A failure in one target is logged and the others still run.
   */
  async runOnce(now: Date = new Date()): Promise<Record<string, number>> {
    const effective = await this.settings.effective();
    if (!effective.enabled) return {};

    const routineDays = this.routineDaysOverride?.() ?? effective.routineDays;
    const cutoff = new Date(now.getTime() - routineDays * DAY_MS).toISOString();
    // Routed orders keep their longer window, but never a shorter one than routine.
    const routedCutoff = new Date(
      now.getTime() - Math.max(effective.routedOrderDays, routineDays) * DAY_MS,
    ).toISOString();

    const deleted: Record<string, number> = {};
    const targets: [string, () => Promise<number>][] = [
      [
        "operations",
        () =>
          this.batched(() => this.operations.purgeRoutine(cutoff, routedCutoff, RETENTION_BATCH)),
      ],
      ["audit_events", () => this.batched(() => this.audit.purgeRoutine(cutoff, RETENTION_BATCH))],
      ["idempotency_keys", () => this.idempotency.purgeExpired(now)],
      ["ui_sessions", () => this.sessions.purgeExpired(now.toISOString())],
      [
        "dpm_wallet_audit_events",
        () =>
          this.batched(
            async () => (await this.upstream.purgeRoutineAudit(cutoff, RETENTION_BATCH)).deleted,
          ),
      ],
    ];
    for (const [table, work] of targets) {
      try {
        deleted[table] = await work();
      } catch (err) {
        deleted[table] = 0;
        logError("retention.failed", { table, err });
      }
    }
    logInfo("retention.run", deleted);
    return deleted;
  }

  /** Repeats `deleteBatch` until a batch comes back short, up to the per-run batch cap. */
  private async batched(deleteBatch: () => Promise<number>): Promise<number> {
    let total = 0;
    for (let i = 0; i < RETENTION_MAX_BATCHES; i++) {
      const n = await deleteBatch();
      total += n;
      if (n < RETENTION_BATCH) break;
    }
    return total;
  }
}
