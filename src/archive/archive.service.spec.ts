import type { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { Config } from "../config";
import type { Archive, ArchiveRepository } from "../db/repositories/archive.repo";
import type { AuditRepository } from "../db/repositories/audit.repo";
import type { OperationRepository } from "../db/repositories/operation.repo";
import type { AuditLog } from "../observability/audit";
import { ARCHIVE_DELETE_BATCH, ArchiveService } from "./archive.service";

const ARCHIVE: Archive = {
  id: "3f9a1c2e-7b44-4c1d-9d0e-6a3b5c7d8e9f",
  before: "2026-01-01T00:00:00.000Z",
  scope: {
    "manager.operations": { maxId: 99, rows: 12_000 },
    "manager.audit_events": { maxId: 7, rows: 2 },
    "wallet.audit_events": { maxId: 0, rows: 0 },
  },
  status: "deleting",
  sha256: "x",
  byteSize: 1,
  rowCount: 12_002,
  deleted: null,
  createdByUserId: null,
  createdByKeyId: null,
  createdAt: "2026-02-01T00:00:00.000Z",
  downloadedAt: "2026-02-01T00:00:00.000Z",
  deletedAt: null,
};

function build(operationBatch: (batch: number) => Promise<number>) {
  const archives = {
    findDeleting: jest.fn().mockResolvedValue([ARCHIVE]),
    setDeleted: jest.fn().mockResolvedValue(undefined),
    vacuum: jest.fn().mockResolvedValue(undefined),
    markDone: jest.fn().mockResolvedValue(undefined),
  };
  const operations = {
    deleteArchived: jest.fn((_bound: unknown, batch: number) => operationBatch(batch)),
  };
  const audit = { deleteArchived: jest.fn().mockResolvedValue(2) };
  const upstream = { deleteArchivedAudit: jest.fn() };
  const service = new ArchiveService(
    archives as unknown as ArchiveRepository,
    operations as unknown as OperationRepository,
    audit as unknown as AuditRepository,
    {} as AuditLog,
    upstream as unknown as DpmWalletClient,
    {} as Config,
  );
  return { service, archives, operations, audit, upstream };
}

describe("ArchiveService delete loop", () => {
  it("deletes in batches of 5000, never more than the scope's row count, then vacuums", async () => {
    const { service, archives, operations, upstream } = build(async (batch) => batch);
    service.resume();
    while (archives.markDone.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(operations.deleteArchived.mock.calls.map((call) => call[1])).toEqual([
      ARCHIVE_DELETE_BATCH,
      ARCHIVE_DELETE_BATCH,
      2000,
    ]);
    // A table with nothing in scope is never called.
    expect(upstream.deleteArchivedAudit).not.toHaveBeenCalled();
    expect(archives.vacuum).toHaveBeenCalledWith(["operations", "audit_events"]);
    expect(archives.markDone).toHaveBeenCalledWith(
      ARCHIVE.id,
      { "manager.operations": 12_000, "manager.audit_events": 2, "wallet.audit_events": 0 },
      expect.any(String),
    );
  });

  it("stops between batches on shutdown, leaving the archive deleting", async () => {
    let release: () => void = () => undefined;
    const { service, archives, operations } = build(
      (batch) => new Promise((resolve) => (release = () => resolve(batch))),
    );
    service.resume();
    await new Promise((resolve) => setImmediate(resolve));
    const stopping = service.onModuleDestroy();
    release();
    await stopping;
    expect(operations.deleteArchived).toHaveBeenCalledTimes(1);
    expect(archives.setDeleted).toHaveBeenCalledWith(ARCHIVE.id, {
      "manager.operations": ARCHIVE_DELETE_BATCH,
      "manager.audit_events": 0,
      "wallet.audit_events": 0,
    });
    expect(archives.vacuum).not.toHaveBeenCalled();
    expect(archives.markDone).not.toHaveBeenCalled();
  });
});
