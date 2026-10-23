import { Inject, Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import { validationFailed } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { TRANSACTION, type Transaction } from "../tokens";
import type { SettingSource } from "./retention-settings.service";

/** `platform_settings` keys. A row exists only while the dashboard overrides the default. */
export const STORAGE_KEYS = {
  warningPercent: "storage.warning_percent",
  warningDays: "storage.warning_days",
  criticalPercent: "storage.critical_percent",
  criticalDays: "storage.critical_days",
  alertWebhookUrl: "storage.alert_webhook_url",
} as const;

export const STORAGE_DEFAULTS = {
  warningPercent: 75,
  warningDays: 30,
  criticalPercent: 90,
  criticalDays: 7,
  alertWebhookUrl: null,
} as const;

const MAX_URL_LENGTH = 2048;

type SettingName = keyof typeof STORAGE_KEYS;

export type StorageValues = {
  warningPercent: number;
  warningDays: number;
  criticalPercent: number;
  criticalDays: number;
  /** `null` while no alert webhook is configured. */
  alertWebhookUrl: string | null;
};

/** Storage settings have no environment defaults, so a source is `default` or `dashboard`. */
export type EffectiveStorage = StorageValues & { sources: Record<SettingName, SettingSource> };

/** A missing key leaves the setting alone; `null` clears the dashboard value. */
export type StoragePatch = { [K in SettingName]?: StorageValues[K] | null };

/** Disk-pressure thresholds, read fresh on every call so a change applies without a restart. */
@Injectable()
export class StorageSettingsService {
  constructor(
    private readonly settings: PlatformSettingsRepository,
    private readonly audit: AuditLog,
    @Inject(TRANSACTION) private readonly transaction: Transaction,
  ) {}

  async effective(): Promise<EffectiveStorage> {
    const stored = await this.settings.all();
    const pick = <K extends SettingName>(
      name: K,
      parse: (raw: string) => StorageValues[K] | undefined,
    ): [StorageValues[K], SettingSource] => {
      const raw = stored[STORAGE_KEYS[name]];
      // A hand-edited, unparseable row is ignored rather than breaking the page.
      const value = raw === undefined ? undefined : parse(raw);
      return value === undefined ? [STORAGE_DEFAULTS[name], "default"] : [value, "dashboard"];
    };
    const [warningPercent, wp] = pick("warningPercent", (r) => parseInt_(r, 1, 99));
    const [warningDays, wd] = pick("warningDays", (r) => parseInt_(r, 1, 365));
    const [criticalPercent, cp] = pick("criticalPercent", (r) => parseInt_(r, 1, 99));
    const [criticalDays, cd] = pick("criticalDays", (r) => parseInt_(r, 1, 365));
    const [alertWebhookUrl, au] = pick("alertWebhookUrl", (r) => (isHttpUrl(r) ? r : undefined));
    return {
      warningPercent,
      warningDays,
      criticalPercent,
      criticalDays,
      alertWebhookUrl,
      sources: {
        warningPercent: wp,
        warningDays: wd,
        criticalPercent: cp,
        criticalDays: cd,
        alertWebhookUrl: au,
      },
    };
  }

  /**
   * Applies `patch`, refusing it whole when the resulting values break a bound. Returns the new
   * effective settings and audits the old and new values.
   */
  async update(patch: StoragePatch, actor: Actor | undefined): Promise<EffectiveStorage> {
    const before = await this.effective();
    const issues: string[] = [];

    for (const name of ["warningPercent", "criticalPercent"] as const) {
      const value = patch[name];
      if (value !== undefined && value !== null && !isInt(value, 1, 99)) {
        issues.push(`${name} must be a whole number from 1 to 99`);
      }
    }
    for (const name of ["warningDays", "criticalDays"] as const) {
      const value = patch[name];
      if (value !== undefined && value !== null && !isInt(value, 1, 365)) {
        issues.push(`${name} must be a whole number of days from 1 to 365`);
      }
    }
    const url = patch.alertWebhookUrl;
    if (url !== undefined && url !== null && !isHttpUrl(url)) {
      issues.push("alertWebhookUrl must be an http or https URL");
    }
    if (issues.length > 0) throw validationFailed("Invalid storage settings", { issues });

    // Bounds are checked against what would be in force after the patch, not the patch alone.
    const resolve = <K extends SettingName>(name: K): StorageValues[K] => {
      const value = patch[name];
      if (value === undefined) return before[name];
      return value === null ? STORAGE_DEFAULTS[name] : value;
    };
    if (resolve("warningPercent") >= resolve("criticalPercent")) {
      issues.push("warningPercent must be below criticalPercent");
    }
    if (resolve("warningDays") <= resolve("criticalDays")) {
      issues.push("warningDays must be above criticalDays");
    }
    if (issues.length > 0) throw validationFailed("Invalid storage settings", { issues });

    const now = new Date().toISOString();
    await this.transaction(async (manager) => {
      for (const name of Object.keys(STORAGE_KEYS) as SettingName[]) {
        const value = patch[name];
        if (value === undefined) continue;
        if (value === null) await this.settings.delete(STORAGE_KEYS[name], manager);
        else await this.settings.set(STORAGE_KEYS[name], String(value), now, manager);
      }
    });

    const effective = await this.effective();
    await this.audit.record({
      actor,
      action: AuditAction.SettingsStorageUpdate,
      outcome: AuditOutcome.Success,
      detail: {
        before: auditValues(before),
        after: auditValues(effective),
        changed: Object.keys(patch),
      },
    });
    return effective;
  }
}

/** A webhook URL often carries a secret in its path, so the trail keeps only where it points. */
function auditValues(effective: EffectiveStorage): StorageValues {
  const { warningPercent, warningDays, criticalPercent, criticalDays, alertWebhookUrl } = effective;
  return {
    warningPercent,
    warningDays,
    criticalPercent,
    criticalDays,
    alertWebhookUrl: alertWebhookUrl === null ? null : `${new URL(alertWebhookUrl).origin}/…`,
  };
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseInt_(raw: string, min: number, max: number): number | undefined {
  const value = Number(raw);
  return isInt(value, min, max) ? value : undefined;
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_URL_LENGTH) {
    return false;
  }
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
