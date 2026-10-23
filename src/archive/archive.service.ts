import { randomUUID } from "node:crypto";

import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import type { Response } from "express";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { UpstreamAuditExportPage } from "../clients/dpm-wallet.types";
import type { Actor } from "../common/actor";
import type { Config } from "../config";
import type { ArchiveScope } from "../db/entities";
import { ArchiveRepository, type Archive } from "../db/repositories/archive.repo";
import { AuditRepository } from "../db/repositories/audit.repo";
import { ARCHIVE_START, OperationRepository } from "../db/repositories/operation.repo";
import { ManagerError, validationFailed } from "../errors";
import { AuditLog, type AuditRecord } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { logError, logInfo } from "../observability/log";
import { CONFIG } from "../tokens";
import { archiveCode, archiveFileName, installName, writeArchive } from "./archive-writer";

export const ARCHIVE_TABLES = {
  operations: "manager.operations",
  audit: "manager.audit_events",
  wallet: "wallet.audit_events",
} as const;

/** Rows per export page, from this service's tables and from dpm-wallet's. */
export const ARCHIVE_PAGE = 1000;
/** Rows per delete batch. */
export const ARCHIVE_DELETE_BATCH = 5000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Important records out to a file the operator keeps, and then out of the database.
 *
 * The scope is fixed when the archive is created: per table, the highest id (`seq` for
 * operations) among the important rows older than the cutoff. A row written later is never in
 * scope, whatever its `created_at`. The download streams exactly that scope; the delete removes
 * exactly that scope, capped at the number of rows the file was checked to hold, and only after a
 * complete download and the 6-character code from the file name.
 */
@Injectable()
export class ArchiveService implements OnModuleDestroy {
  /** Set on shutdown: the delete loop stops between batches and resumes on the next boot. */
  private stopped = false;
  private running: Promise<void> | undefined;
  /** A delete requested while the loop was already going; it looks again before it exits. */
  private again = false;

  constructor(
    private readonly archives: ArchiveRepository,
    private readonly operations: OperationRepository,
    private readonly auditEvents: AuditRepository,
    private readonly audit: AuditLog,
    private readonly upstream: DpmWalletClient,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.running?.catch(() => undefined);
  }

  /** Rows per table an archive cut at `before` would cover right now. */
  async preview(before: string): Promise<{ tables: Record<string, number> }> {
    const scope = await this.scope(checkedCutoff(before));
    return {
      tables: Object.fromEntries(Object.entries(scope).map(([table, s]) => [table, s.rows])),
    };
  }

  async create(
    rawBefore: string,
    actor: Actor,
  ): Promise<{ id: string; code: string; scope: ArchiveScope }> {
    const before = checkedCutoff(rawBefore);
    if (await this.archives.findOpen()) throw inProgress();
    const scope = await this.scope(before);
    const id = randomUUID();
    const inserted = await this.archives.insertPending({
      id,
      before,
      scope,
      createdByUserId: actor.userId,
      createdByKeyId: actor.keyId,
      createdAt: new Date().toISOString(),
    });
    if (!inserted) throw inProgress();
    await this.audit.record({
      actor,
      action: AuditAction.ArchiveCreate,
      outcome: AuditOutcome.Success,
      detail: { archiveId: id, before, scope },
    });
    return { id, code: archiveCode(id), scope };
  }

  async list(limit: number, offset: number): Promise<{ items: Archive[]; total: number }> {
    return this.archives.list(limit, offset);
  }

  /**
   * Streams the archive to `res`. The record becomes `downloaded` (with the file's SHA-256, size
   * and row count) only once the last byte has been handed off; a client that breaks off leaves it
   * `pending`, to be downloaded again.
   */
  async download(id: string, actor: Actor, res: Response): Promise<void> {
    const archive = await this.find(id);
    if (archive.status !== "pending" && archive.status !== "downloaded") {
      throw notReady(`Archive ${id} is ${archive.status}; its rows can no longer be downloaded.`);
    }
    const install = installName(this.config.managerPublicUrl);

    // dpm-wallet's first page is fetched before a byte is written, so dpm-wallet being down
    // answers as an error response rather than a cut-off file.
    const wallet = archive.scope[ARCHIVE_TABLES.wallet];
    let firstWalletPage: UpstreamAuditExportPage | undefined;
    if (wallet && wallet.rows > 0) {
      try {
        firstWalletPage = await this.upstream.auditExport({
          before: archive.before,
          maxId: wallet.maxId,
          limit: ARCHIVE_PAGE,
        });
      } catch (err) {
        await this.recordQuietly({
          actor,
          action: AuditAction.ArchiveDownload,
          outcome: AuditOutcome.Failure,
          detail: { archiveId: id, reason: "upstream", rowsSent: 0 },
        });
        throw err;
      }
    }

    res.status(200);
    res.setHeader("Content-Type", "application/gzip");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${archiveFileName(install, archive.createdAt, archive.id)}"`,
    );
    res.setHeader("Cache-Control", "no-store");

    const counted = { rows: 0 };
    try {
      const file = await writeArchive(
        this.records(archive, install, counted, firstWalletPage),
        res,
      );
      const recorded = await this.archives.markDownloaded(id, {
        ...file,
        rowCount: counted.rows,
        at: new Date().toISOString(),
      });
      await this.recordQuietly({
        actor,
        action: AuditAction.ArchiveDownload,
        outcome: recorded ? AuditOutcome.Success : AuditOutcome.Failure,
        detail: { archiveId: id, ...file, rowCount: counted.rows, recorded },
      });
    } catch (err) {
      // ERR_STREAM_PREMATURE_CLOSE is a client that broke off; anything else failed on this side.
      const reason = (err as { code?: string }).code ?? "error";
      logError("archive.download_failed", { archiveId: id, reason, err });
      // The response is already gone; nothing thrown from here could reach the client, so an
      // audit failure must not become an unhandled rejection either.
      await this.recordQuietly({
        actor,
        action: AuditAction.ArchiveDownload,
        outcome: AuditOutcome.Failure,
        detail: { archiveId: id, reason, rowsSent: counted.rows },
      });
    }
  }

  /**
   * Starts removing an archive's rows, in the background. Refused unless the archive was
   * downloaded completely and `code` matches the one in its file name. An archive left
   * `deleting` by a failure or a restart is resumed by the same call.
   */
  async requestDelete(id: string, code: string, actor: Actor): Promise<{ status: "deleting" }> {
    const archive = await this.find(id);
    const deny = async (reason: string): Promise<void> =>
      this.audit.record({
        actor,
        action: AuditAction.ArchiveDelete,
        outcome: AuditOutcome.Denied,
        detail: { archiveId: id, reason },
      });
    if (archive.status !== "downloaded" && archive.status !== "deleting") {
      await deny(`status ${archive.status}`);
      throw notReady(
        archive.status === "pending"
          ? `Archive ${id} has not been downloaded completely; download it before deleting.`
          : `Archive ${id} is already ${archive.status}.`,
      );
    }
    if (code.trim().toUpperCase() !== archiveCode(id)) {
      await deny("code mismatch");
      throw new ManagerError(
        "ARCHIVE_CODE_MISMATCH",
        "The code does not match the archive's file name. Nothing was deleted.",
      );
    }
    if (archive.status === "downloaded") {
      // Before the first batch: the manager tables must still hold exactly what the file holds.
      const changed = await this.scopeChanges(archive);
      if (changed.length > 0) {
        await deny(`scope changed: ${changed.join(", ")}`);
        throw new ManagerError(
          "ARCHIVE_SCOPE_CHANGED",
          `The rows in scope no longer match the archive (${changed.join(", ")}). Nothing was ` +
            "deleted; cancel this archive and create a new one.",
          { details: { tables: changed } },
        );
      }
    }
    if (!(await this.archives.markDeleting(id))) throw notReady(`Archive ${id} changed state.`);
    await this.audit.record({
      actor,
      action: AuditAction.ArchiveDelete,
      outcome: AuditOutcome.Success,
      detail: { archiveId: id, scope: archive.scope, sha256: archive.sha256 },
    });
    this.resume();
    return { status: "deleting" };
  }

  /**
   * Abandons a `pending` or `downloaded` archive. Deletes nothing and touches no record; the
   * archive stays in the history as `cancelled`, and a new one can be created.
   */
  async cancel(id: string, actor: Actor): Promise<{ status: "cancelled" }> {
    const archive = await this.find(id);
    if (!(await this.archives.markCancelled(id))) {
      await this.audit.record({
        actor,
        action: AuditAction.ArchiveCancel,
        outcome: AuditOutcome.Denied,
        detail: { archiveId: id, reason: `status ${archive.status}` },
      });
      throw new ManagerError(
        "ARCHIVE_NOT_CANCELLABLE",
        `Archive ${id} is ${archive.status}; only a pending or downloaded archive can be cancelled.`,
      );
    }
    await this.audit.record({
      actor,
      action: AuditAction.ArchiveCancel,
      outcome: AuditOutcome.Success,
      detail: { archiveId: id, previousStatus: archive.status },
    });
    return { status: "cancelled" };
  }

  /** The manager tables whose in-scope count differs from the archive's fixed `rows`. */
  private async scopeChanges(archive: Archive): Promise<string[]> {
    const { before, scope } = archive;
    const counts: [string, () => Promise<number>][] = [
      [
        ARCHIVE_TABLES.operations,
        () =>
          this.operations.countArchived({
            before,
            maxSeq: scope[ARCHIVE_TABLES.operations]?.maxId ?? 0,
          }),
      ],
      [
        ARCHIVE_TABLES.audit,
        () =>
          this.auditEvents.countArchived({
            before,
            maxId: scope[ARCHIVE_TABLES.audit]?.maxId ?? 0,
          }),
      ],
    ];
    const changed: string[] = [];
    for (const [table, count] of counts) {
      if ((await count()) !== (scope[table]?.rows ?? 0)) changed.push(table);
    }
    return changed;
  }

  private async recordQuietly(record: AuditRecord): Promise<void> {
    try {
      await this.audit.record(record);
    } catch (err) {
      logError("archive.audit_failed", { action: record.action, err });
    }
  }

  /**
   * Runs (or re-runs) the delete of every archive left `deleting`, in the background. Called at
   * boot and after a confirmed delete; never throws.
   */
  resume(): void {
    if (this.stopped) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.drain().finally(() => {
      this.running = undefined;
    });
  }

  private async drain(): Promise<void> {
    do {
      this.again = false;
      try {
        for (const archive of await this.archives.findDeleting()) {
          if (this.stopped) return;
          await this.deleteRows(archive);
        }
      } catch (err) {
        // Left `deleting`: the next confirm, or the next boot, picks it up where it stopped.
        if (!this.stopped) logError("archive.delete_failed", { err });
      }
    } while (this.again && !this.stopped);
  }

  private async deleteRows(archive: Archive): Promise<void> {
    const { before, scope } = archive;
    const deleted: Record<string, number> = {
      [ARCHIVE_TABLES.operations]: 0,
      [ARCHIVE_TABLES.audit]: 0,
      [ARCHIVE_TABLES.wallet]: 0,
      ...archive.deleted,
    };
    const steps: [string, (batch: number, maxId: number) => Promise<number>][] = [
      [
        ARCHIVE_TABLES.operations,
        (batch, maxSeq) => this.operations.deleteArchived({ before, maxSeq }, batch),
      ],
      [
        ARCHIVE_TABLES.audit,
        (batch, maxId) => this.auditEvents.deleteArchived({ before, maxId }, batch),
      ],
      [
        ARCHIVE_TABLES.wallet,
        async (batch, maxId) =>
          (await this.upstream.deleteArchivedAudit({ before, maxId, batch })).deleted,
      ],
    ];
    for (const [table, step] of steps) {
      const bound = scope[table];
      if (!bound) continue;
      for (;;) {
        if (this.stopped) return;
        // Never more rows than the file was checked to hold.
        const remaining = bound.rows - (deleted[table] ?? 0);
        if (remaining <= 0) break;
        const batch = Math.min(ARCHIVE_DELETE_BATCH, remaining);
        const n = await step(batch, bound.maxId);
        deleted[table] = (deleted[table] ?? 0) + n;
        await this.archives.setDeleted(archive.id, deleted);
        if (n < batch) break;
      }
    }
    if (this.stopped) return;
    // dpm-wallet reclaims its own space; this service vacuums only its own tables.
    const touched = (
      [
        ["operations", ARCHIVE_TABLES.operations],
        ["audit_events", ARCHIVE_TABLES.audit],
      ] as const
    )
      .filter(([, table]) => (scope[table]?.rows ?? 0) > 0)
      .map(([name]) => name);
    await this.archives.vacuum(touched);
    await this.archives.markDone(archive.id, deleted, new Date().toISOString());
    logInfo("archive.done", { archiveId: archive.id, deleted });
  }

  /** The manifest line, then one `{table, row}` line per row in scope, table by table. */
  private async *records(
    archive: Archive,
    install: string,
    counted: { rows: number },
    firstWalletPage?: UpstreamAuditExportPage,
  ): AsyncGenerator<unknown> {
    const { before, scope } = archive;
    yield {
      archiveId: archive.id,
      install,
      mode: this.config.mode,
      createdAt: archive.createdAt,
      before,
      tables: scope,
    };

    const check = (table: string, rows: number): void => {
      // The scope is immutable, so a different count means the database changed underneath:
      // abandon the file rather than confirm one that does not match what a delete would remove.
      if (rows !== (scope[table]?.rows ?? 0)) {
        throw new Error(`${table}: ${rows} rows exported, scope says ${scope[table]?.rows ?? 0}`);
      }
    };

    const ops = scope[ARCHIVE_TABLES.operations];
    let rows = 0;
    if (ops && ops.rows > 0) {
      for (let after = ARCHIVE_START; ;) {
        const page = await this.operations.importantPage(
          { before, maxSeq: ops.maxId },
          after,
          ARCHIVE_PAGE,
        );
        for (const { operation } of page) {
          yield { table: ARCHIVE_TABLES.operations, row: operation };
          rows++;
          counted.rows++;
        }
        const last = page.at(-1);
        if (!last || page.length < ARCHIVE_PAGE) break;
        after = last.position;
      }
    }
    check(ARCHIVE_TABLES.operations, rows);

    const audit = scope[ARCHIVE_TABLES.audit];
    rows = 0;
    if (audit && audit.rows > 0) {
      for (let after = 0; ;) {
        const page = await this.auditEvents.importantPage(
          { before, maxId: audit.maxId },
          after,
          ARCHIVE_PAGE,
        );
        for (const event of page) {
          yield { table: ARCHIVE_TABLES.audit, row: event };
          rows++;
          counted.rows++;
        }
        const last = page.at(-1);
        if (!last || page.length < ARCHIVE_PAGE) break;
        after = last.id;
      }
    }
    check(ARCHIVE_TABLES.audit, rows);

    const wallet = scope[ARCHIVE_TABLES.wallet];
    rows = 0;
    if (wallet && wallet.rows > 0) {
      let cursor: string | undefined;
      do {
        const page =
          cursor === undefined && firstWalletPage
            ? firstWalletPage
            : await this.upstream.auditExport({
                before,
                maxId: wallet.maxId,
                limit: ARCHIVE_PAGE,
                ...(cursor === undefined ? {} : { cursor }),
              });
        for (const row of page.items) {
          if (row.id > wallet.maxId) throw new Error(`wallet.audit_events: id ${row.id} > maxId`);
          yield { table: ARCHIVE_TABLES.wallet, row };
          rows++;
          counted.rows++;
        }
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
    }
    check(ARCHIVE_TABLES.wallet, rows);
  }

  private async scope(before: string): Promise<ArchiveScope> {
    const [operations, audit, wallet] = await Promise.all([
      this.operations.importantScope(before),
      this.auditEvents.importantScope(before),
      this.upstream.auditScope(before),
    ]);
    return {
      [ARCHIVE_TABLES.operations]: { maxId: operations.maxSeq, rows: operations.rows },
      [ARCHIVE_TABLES.audit]: audit,
      [ARCHIVE_TABLES.wallet]: { maxId: wallet.maxId, rows: wallet.rows },
    };
  }

  private async find(id: string): Promise<Archive> {
    const archive = await this.archives.findById(id);
    if (!archive) throw new ManagerError("ARCHIVE_NOT_FOUND", `No archive with id ${id}`);
    return archive;
  }
}

/** A cutoff must be a timestamp at least a day old; returned normalised to ISO 8601 UTC. */
function checkedCutoff(before: string): string {
  const at = Date.parse(before);
  if (Number.isNaN(at)) throw validationFailed("before must be an ISO 8601 timestamp");
  if (at > Date.now() - DAY_MS) throw validationFailed("before must be at least 1 day ago");
  return new Date(at).toISOString();
}

function inProgress(): ManagerError {
  return new ManagerError(
    "ARCHIVE_IN_PROGRESS",
    "Another archive is not done yet. Download it and confirm its delete first.",
  );
}

function notReady(message: string): ManagerError {
  return new ManagerError("ARCHIVE_NOT_READY", message);
}
