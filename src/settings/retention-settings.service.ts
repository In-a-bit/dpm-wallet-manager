import { Inject, Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import { RETENTION_MAX_DAYS, RETENTION_MIN_DAYS, type Config } from "../config";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import { validationFailed } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { CONFIG, TRANSACTION, type Transaction } from "../tokens";

/** `platform_settings` keys. A row exists only while the dashboard overrides the default. */
export const RETENTION_KEYS = {
  enabled: "retention.enabled",
  routineDays: "retention.routine_days",
  routedOrderDays: "retention.routed_order_days",
  archiveReminderDays: "archive.reminder_days",
} as const;

/** Important records older than this make the dashboard suggest an archive. */
export const DEFAULT_ARCHIVE_REMINDER_DAYS = 730;

type SettingName = keyof typeof RETENTION_KEYS;
export type SettingSource = "dashboard" | "environment" | "default";

export type RetentionValues = {
  enabled: boolean;
  routineDays: number;
  routedOrderDays: number;
  archiveReminderDays: number;
};

export type EffectiveRetention = RetentionValues & {
  sources: Record<SettingName, SettingSource>;
};

/** A missing key leaves the setting alone; `null` clears the dashboard value. */
export type RetentionPatch = { [K in SettingName]?: RetentionValues[K] | null };

/**
 * Retention settings: what the dashboard sets wins, the environment supplies the defaults.
 *
 * Read fresh on every call, so a change takes effect on the next retention run without a restart.
 */
@Injectable()
export class RetentionSettingsService {
  constructor(
    private readonly settings: PlatformSettingsRepository,
    private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: Config,
    @Inject(TRANSACTION) private readonly transaction: Transaction,
  ) {}

  async effective(): Promise<EffectiveRetention> {
    const stored = await this.settings.all();
    const defaults = this.config.retentionDefaults;
    const pick = <K extends SettingName>(
      name: K,
      parse: (raw: string) => RetentionValues[K] | undefined,
      fallback: RetentionValues[K],
      fallbackSource: SettingSource,
    ): [RetentionValues[K], SettingSource] => {
      const raw = stored[RETENTION_KEYS[name]];
      // A hand-edited, unparseable row is ignored rather than allowed to stop the trimming.
      const value = raw === undefined ? undefined : parse(raw);
      return value === undefined ? [fallback, fallbackSource] : [value, "dashboard"];
    };

    const [enabled, enabledSource] = pick("enabled", parseBool, defaults.enabled, "environment");
    const [routineDays, routineSource] = pick(
      "routineDays",
      parseDays,
      defaults.routineDays,
      "environment",
    );
    const [routedOrderDays, routedSource] = pick(
      "routedOrderDays",
      parseDays,
      defaults.routedOrderDays,
      "environment",
    );
    const [archiveReminderDays, reminderSource] = pick(
      "archiveReminderDays",
      parseDays,
      DEFAULT_ARCHIVE_REMINDER_DAYS,
      "default",
    );
    return {
      enabled,
      routineDays,
      routedOrderDays,
      archiveReminderDays,
      sources: {
        enabled: enabledSource,
        routineDays: routineSource,
        routedOrderDays: routedSource,
        archiveReminderDays: reminderSource,
      },
    };
  }

  /**
   * Applies `patch`, refusing it whole when the resulting values break a bound. Returns the new
   * effective settings and audits the old and new values.
   */
  async update(patch: RetentionPatch, actor: Actor | undefined): Promise<EffectiveRetention> {
    const before = await this.effective();
    const issues: string[] = [];

    for (const name of ["routineDays", "routedOrderDays", "archiveReminderDays"] as const) {
      const value = patch[name];
      if (value === undefined || value === null) continue;
      if (!isDays(value)) {
        issues.push(
          `${name} must be a whole number of days from ${RETENTION_MIN_DAYS} to ${RETENTION_MAX_DAYS}`,
        );
      }
    }
    if (
      patch.enabled !== undefined &&
      patch.enabled !== null &&
      typeof patch.enabled !== "boolean"
    ) {
      issues.push("enabled must be true or false");
    }
    if (issues.length > 0) throw validationFailed("Invalid retention settings", { issues });

    // Bounds are checked against what would be in force after the patch, not the patch alone.
    const after = this.afterPatch(before, patch);
    if (after.routedOrderDays < after.routineDays) {
      issues.push("routedOrderDays must not be below routineDays");
    }
    if (after.archiveReminderDays < after.routineDays) {
      issues.push("archiveReminderDays must not be below routineDays");
    }
    if (issues.length > 0) throw validationFailed("Invalid retention settings", { issues });

    const now = new Date().toISOString();
    await this.transaction(async (manager) => {
      for (const name of Object.keys(RETENTION_KEYS) as SettingName[]) {
        const value = patch[name];
        if (value === undefined) continue;
        if (value === null) await this.settings.delete(RETENTION_KEYS[name], manager);
        else await this.settings.set(RETENTION_KEYS[name], String(value), now, manager);
      }
    });

    const effective = await this.effective();
    await this.audit.record({
      actor,
      action: AuditAction.SettingsRetentionUpdate,
      outcome: AuditOutcome.Success,
      detail: { before: values(before), after: values(effective), patch },
    });
    return effective;
  }

  private afterPatch(before: EffectiveRetention, patch: RetentionPatch): RetentionValues {
    const defaults = this.config.retentionDefaults;
    const resolve = <K extends SettingName>(name: K, fallback: RetentionValues[K]) => {
      const value = patch[name];
      if (value === undefined) return before[name];
      return value === null ? fallback : value;
    };
    return {
      enabled: resolve("enabled", defaults.enabled),
      routineDays: resolve("routineDays", defaults.routineDays),
      routedOrderDays: resolve("routedOrderDays", defaults.routedOrderDays),
      archiveReminderDays: resolve("archiveReminderDays", DEFAULT_ARCHIVE_REMINDER_DAYS),
    };
  }
}

function values(effective: EffectiveRetention): RetentionValues {
  const { enabled, routineDays, routedOrderDays, archiveReminderDays } = effective;
  return { enabled, routineDays, routedOrderDays, archiveReminderDays };
}

function isDays(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= RETENTION_MIN_DAYS &&
    value <= RETENTION_MAX_DAYS
  );
}

function parseDays(raw: string): number | undefined {
  const value = Number(raw);
  return isDays(value) ? value : undefined;
}

function parseBool(raw: string): boolean | undefined {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return undefined;
}
