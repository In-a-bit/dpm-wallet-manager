import { statfs as nodeStatfs } from "node:fs/promises";

import { Injectable, type OnModuleDestroy, type OnModuleInit } from "@nestjs/common";

import { RETENTION_MIN_DAYS } from "../config";
import {
  StorageSampleRepository,
  type StorageSample,
} from "../db/repositories/storage-sample.repo";
import { logInfo, logWarn } from "../observability/log";
import { RetentionService } from "../retention/retention.service";
import { RetentionSettingsService } from "../settings/retention-settings.service";
import { maskWebhookUrl, StorageSettingsService } from "../settings/storage-settings.service";
import { daysToFull, growthPerDay, levelFor, type StorageLevel } from "./growth";

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * MIN_MS;
const FIRST_SAMPLE_MS = 10_000;
const SAMPLE_INTERVAL_MS = 15 * MIN_MS;
const HISTORY_DAYS = 7;
/** At critical, routine records are kept this long; if it is still critical a day later, less. */
const TIGHTENED_DAYS = 30;
const TIGHTENED_DAYS_ESCALATED = 7;
const DEFAULT_STORAGE_PATH = "/storage/pg";

export type DiskInfo = { totalBytes: number; freeBytes: number };
export type StorageView = {
  at: string;
  disk: { totalBytes: number; freeBytes: number; usedPercent: number } | null;
  databases: { wallet: number | null; manager: number };
  tables: { db: string; name: string; bytes: number; estRows: number }[];
  growthBytesPerDay: number | null;
  daysToFull: number | null;
  level: StorageLevel;
  tightened: { routineDays: number; since: string } | null;
  oldestImportantAt: string | null;
  archiveSuggested: boolean;
};

/**
 * Samples the disk and the databases every 15 minutes, derives growth and a level, tells the
 * operator (log line, optional webhook) when the level changes, and tells retention to keep
 * routine records for less time while the disk is critical.
 *
 * Nothing here may throw out of a timer or slow a request: a monitor that breaks the service it
 * watches is worse than none.
 */
@Injectable()
export class StorageMonitorService implements OnModuleInit, OnModuleDestroy {
  // Injectable for tests.
  clock: () => Date = () => new Date();
  statfs: (path: string) => Promise<DiskInfo> = async (path) => {
    const s = await nodeStatfs(path);
    return {
      totalBytes: Number(s.blocks) * Number(s.bsize),
      freeBytes: Number(s.bavail) * Number(s.bsize),
    };
  };
  fetchImpl: typeof fetch = (...args) => fetch(...args);
  webhookTimeoutMs = 5000;
  storagePath = process.env.STORAGE_PATH?.trim() || DEFAULT_STORAGE_PATH;

  private firstTimer: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private stopped = false;
  private sampling = false;
  private warnedUnavailable = false;

  private loaded = false;
  private level: StorageLevel = "ok";
  private lastNotifiedAt: number | undefined;
  /** When the current unbroken run of critical samples began. */
  private criticalSince: number | undefined;
  /** When tightening began; it lasts until the level is ok again. */
  private tightenedSince: number | undefined;
  private lastLoggedOverride: number | undefined;

  constructor(
    private readonly samples: StorageSampleRepository,
    private readonly storageSettings: StorageSettingsService,
    private readonly retentionSettings: RetentionSettingsService,
    private readonly retention: RetentionService,
  ) {}

  onModuleInit(): void {
    this.retention.routineDaysOverride = () => this.currentOverride();
    this.firstTimer = setTimeout(() => {
      void this.tick();
      this.interval = setInterval(() => void this.tick(), SAMPLE_INTERVAL_MS);
      this.interval.unref();
    }, FIRST_SAMPLE_MS);
    this.firstTimer.unref();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    clearTimeout(this.firstTimer);
    clearInterval(this.interval);
    this.firstTimer = undefined;
    this.interval = undefined;
  }

  private async tick(): Promise<void> {
    if (this.sampling || this.stopped) return;
    this.sampling = true;
    try {
      await this.sampleOnce();
    } catch (err) {
      if (!this.stopped) logWarn("storage.sample_failed", { err });
    } finally {
      this.sampling = false;
    }
  }

  /** Takes one sample, stores it and acts on the level. Exposed for tests and the first request. */
  async sampleOnce(): Promise<void> {
    const now = this.clock();
    await this.restoreState(now);

    const disk = await this.readDisk();
    const [sizes, tables, settings] = await Promise.all([
      this.samples.databaseSizes(),
      this.samples.tableStats(),
      this.storageSettings.effective(),
    ]);

    const usedPercent = disk ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : null;
    const usedBytes = (s: {
      total: number | null;
      free: number | null;
      wallet: number | null;
      manager: number;
    }) => (s.total !== null && s.free !== null ? s.total - s.free : (s.wallet ?? 0) + s.manager);
    const history = await this.samples.since(
      new Date(now.getTime() - HISTORY_DAYS * DAY_MS).toISOString(),
    );
    const series = [
      ...history.map((h) => ({
        at: h.at,
        usedBytes: usedBytes({
          total: h.diskTotalBytes,
          free: h.diskFreeBytes,
          wallet: h.walletDbBytes,
          manager: h.managerDbBytes,
        }),
      })),
      {
        at: now.toISOString(),
        usedBytes: usedBytes({
          total: disk?.totalBytes ?? null,
          free: disk?.freeBytes ?? null,
          wallet: sizes.wallet,
          manager: sizes.manager,
        }),
      },
    ];
    const growth = growthPerDay(series);
    const days = daysToFull(disk?.freeBytes ?? null, growth);
    const level = levelFor({ usedPercent, freeBytes: disk?.freeBytes ?? null }, growth, settings);

    const sample: StorageSample = {
      at: now.toISOString(),
      diskTotalBytes: disk?.totalBytes ?? null,
      diskFreeBytes: disk?.freeBytes ?? null,
      diskUsedPercent: usedPercent,
      walletDbBytes: sizes.wallet,
      managerDbBytes: sizes.manager,
      tables,
      growthBytesPerDay: growth,
      daysToFull: days,
      level,
    };
    await this.samples.insert(sample);

    const previous = this.level;
    this.level = level;
    if (level === "critical") this.criticalSince ??= now.getTime();
    else this.criticalSince = undefined;
    if (level === "critical") this.tightenedSince ??= now.getTime();
    else if (level === "ok") this.tightenedSince = undefined;
    this.refreshTightening();

    await this.announce(sample, previous, settings.alertWebhookUrl);
  }

  /**
   * The cached latest sample plus what changes between samples. The first call on a fresh install
   * takes a sample, so the page is not empty for the first 10 seconds.
   */
  async view(): Promise<StorageView> {
    let latest = await this.samples.latest();
    if (!latest) {
      await this.sampleOnce();
      latest = await this.samples.latest();
    }
    const sample = latest as StorageSample;
    const [oldestImportantAt, retention] = await Promise.all([
      this.samples.oldestImportantAt().catch(() => null),
      this.retentionSettings.effective(),
    ]);
    const reminderMs = retention.archiveReminderDays * DAY_MS;
    return {
      at: sample.at,
      disk:
        sample.diskTotalBytes !== null &&
        sample.diskFreeBytes !== null &&
        sample.diskUsedPercent !== null
          ? {
              totalBytes: sample.diskTotalBytes,
              freeBytes: sample.diskFreeBytes,
              usedPercent: sample.diskUsedPercent,
            }
          : null,
      databases: { wallet: sample.walletDbBytes, manager: sample.managerDbBytes },
      tables: sample.tables,
      growthBytesPerDay: sample.growthBytesPerDay,
      daysToFull: sample.daysToFull,
      level: sample.level as StorageLevel,
      tightened: await this.tightening(),
      oldestImportantAt,
      archiveSuggested:
        oldestImportantAt !== null &&
        this.clock().getTime() - Date.parse(oldestImportantAt) > reminderMs,
    };
  }

  /** The routine days now in force because of storage pressure, or null when not tightened. */
  async tightening(): Promise<{ routineDays: number; since: string } | null> {
    const override = this.currentOverride();
    if (override === undefined || this.tightenedSince === undefined) return null;
    const configured = (await this.retentionSettings.effective()).routineDays;
    // Already shorter than the tightened value: nothing is being tightened.
    if (configured <= override) return null;
    return { routineDays: override, since: new Date(this.tightenedSince).toISOString() };
  }

  /** Days retention should use now, or undefined for the configured value. */
  private currentOverride(): number | undefined {
    this.refreshTightening();
    return this.computeOverride();
  }

  private computeOverride(): number | undefined {
    if (this.tightenedSince === undefined) return undefined;
    const escalated =
      this.level === "critical" &&
      this.criticalSince !== undefined &&
      this.clock().getTime() - this.criticalSince >= DAY_MS;
    return Math.max(escalated ? TIGHTENED_DAYS_ESCALATED : TIGHTENED_DAYS, RETENTION_MIN_DAYS);
  }

  /** Logs `retention.tightened` whenever the days in force change (null: back to configured). */
  private refreshTightening(): void {
    const override = this.computeOverride();
    if (override === this.lastLoggedOverride) return;
    this.lastLoggedOverride = override;
    logInfo("retention.tightened", {
      routineDays: override ?? null,
      since: this.tightenedSince === undefined ? null : new Date(this.tightenedSince).toISOString(),
    });
  }

  /** After a restart: pick up the last known level and how long it has been critical. */
  private async restoreState(now: Date): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    const recent = await this.samples.since(new Date(now.getTime() - 2 * DAY_MS).toISOString());
    const last = recent[recent.length - 1];
    if (!last) return;
    this.level = last.level as StorageLevel;
    let since: number | undefined;
    for (let i = recent.length - 1; i >= 0 && recent[i]!.level === "critical"; i--) {
      since = Date.parse(recent[i]!.at);
    }
    this.criticalSince = since;
    if (this.level === "critical") this.tightenedSince = since;
    else if (this.level === "warning" && recent.some((s) => s.level === "critical")) {
      // Still between critical and ok: tightening has not been lifted yet.
      const firstCritical = recent.find((s) => s.level === "critical");
      this.tightenedSince = firstCritical ? Date.parse(firstCritical.at) : undefined;
    }
  }

  private async readDisk(): Promise<DiskInfo | null> {
    try {
      const disk = await this.statfs(this.storagePath);
      return disk.totalBytes > 0 ? disk : null;
    } catch (err) {
      if (!this.warnedUnavailable) {
        this.warnedUnavailable = true;
        logWarn("storage.unavailable", { path: this.storagePath, err });
      }
      return null;
    }
  }

  /** Logs a level change (and once a day while not ok), and POSTs the webhook for each. */
  private async announce(
    sample: StorageSample,
    previous: StorageLevel,
    webhook: string | null,
  ): Promise<void> {
    const level = sample.level as StorageLevel;
    const at = Date.parse(sample.at);
    const changed = level !== previous;
    const daily =
      !changed &&
      level !== "ok" &&
      this.lastNotifiedAt !== undefined &&
      at - this.lastNotifiedAt >= DAY_MS;
    if (!changed && !daily) return;
    if (level === "ok" && !changed) return;
    this.lastNotifiedAt = at;

    const fields = {
      level,
      previous,
      usedPercent: sample.diskUsedPercent,
      daysToFull: sample.daysToFull,
      dbBytes: sample.managerDbBytes + (sample.walletDbBytes ?? 0),
    };
    if (level === "ok") logInfo("storage.level", fields);
    else logWarn("storage.level", fields);

    // The daily reminder goes to the webhook only while critical; a level change always does.
    if (webhook && (changed || level === "critical")) {
      await this.postWebhook(webhook, sample);
    }
  }

  private async postWebhook(url: string, sample: StorageSample): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.webhookTimeoutMs);
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          install: installName(),
          level: sample.level,
          usedPercent: sample.diskUsedPercent,
          daysToFull: sample.daysToFull,
          dbBytes: sample.managerDbBytes + (sample.walletDbBytes ?? 0),
          at: sample.at,
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        logWarn("storage.webhook_failed", { target: maskWebhookUrl(url), status: response.status });
      }
    } catch (err) {
      // The error text can carry the URL; keep only its kind.
      logWarn("storage.webhook_failed", {
        target: maskWebhookUrl(url),
        reason: controller.signal.aborted ? "timeout" : err instanceof Error ? err.name : "error",
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

/** The host of MANAGER_PUBLIC_URL, which tells a webhook receiver which install is talking. */
function installName(): string {
  try {
    return new URL(process.env.MANAGER_PUBLIC_URL ?? "").host || "install";
  } catch {
    return "install";
  }
}
