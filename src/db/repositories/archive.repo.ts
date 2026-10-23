import { Inject, Injectable } from "@nestjs/common";
import { In, type Repository } from "typeorm";

import { DB } from "../../tokens";
import type { Db } from "../client";
import { ArchiveEntity, type ArchiveScope, type ArchiveStatus } from "../entities";

export type Archive = {
  id: string;
  before: string;
  scope: ArchiveScope;
  status: ArchiveStatus;
  sha256: string | null;
  byteSize: number | null;
  rowCount: number | null;
  deleted: Record<string, number> | null;
  createdByUserId: string | null;
  createdByKeyId: string | null;
  createdAt: string;
  downloadedAt: string | null;
  deletedAt: string | null;
};

export type NewArchive = Pick<
  Archive,
  "id" | "before" | "scope" | "createdByUserId" | "createdByKeyId" | "createdAt"
>;

/** Postgres' unique_violation, raised by `archives_one_open` when a second archive is opened. */
const UNIQUE_VIOLATION = "23505";

@Injectable()
export class ArchiveRepository {
  private readonly archives: Repository<ArchiveEntity>;

  constructor(@Inject(DB) private readonly db: Db) {
    this.archives = db.getRepository(ArchiveEntity);
  }

  /**
   * Inserts a `pending` archive. Returns false when another archive is not yet `done`: the partial
   * unique index decides, so two concurrent creates cannot both win.
   */
  async insertPending(archive: NewArchive): Promise<boolean> {
    try {
      await this.archives.insert({ ...archive, status: "pending" });
      return true;
    } catch (err) {
      if ((err as { driverError?: { code?: string } }).driverError?.code === UNIQUE_VIOLATION) {
        return false;
      }
      throw err;
    }
  }

  async findById(id: string): Promise<Archive | undefined> {
    return (await this.archives.findOneBy({ id })) ?? undefined;
  }

  async findOpen(): Promise<Archive | undefined> {
    const rows = await this.archives.find({
      where: { status: In(["pending", "downloaded", "deleting"]) },
      take: 1,
    });
    return rows[0];
  }

  async findDeleting(): Promise<Archive[]> {
    return this.archives.find({ where: { status: "deleting" }, order: { createdAt: "ASC" } });
  }

  /** Newest first, with a total. */
  async list(limit: number, offset: number): Promise<{ items: Archive[]; total: number }> {
    const [items, total] = await this.archives.findAndCount({
      order: { createdAt: "DESC", id: "DESC" },
      take: limit,
      skip: offset,
    });
    return { items, total };
  }

  /**
   * Records a complete download. Only from `pending` or `downloaded`, so a download that finishes
   * after a delete started cannot pull the archive back out of `deleting`.
   */
  async markDownloaded(
    id: string,
    file: { sha256: string; byteSize: number; rowCount: number; at: string },
  ): Promise<boolean> {
    const result = await this.archives
      .createQueryBuilder()
      .update()
      .set({
        status: "downloaded",
        sha256: file.sha256,
        byteSize: file.byteSize,
        rowCount: file.rowCount,
        downloadedAt: file.at,
      })
      .where("id = :id AND status IN ('pending', 'downloaded')", { id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /** `downloaded` (or an interrupted `deleting`) to `deleting`; false from any other state. */
  async markDeleting(id: string): Promise<boolean> {
    const result = await this.archives
      .createQueryBuilder()
      .update()
      .set({ status: "deleting" })
      .where("id = :id AND status IN ('downloaded', 'deleting')", { id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  /** `pending` or `downloaded` to `cancelled`; false from any other state. Touches no records. */
  async markCancelled(id: string): Promise<boolean> {
    const result = await this.archives
      .createQueryBuilder()
      .update()
      .set({ status: "cancelled" })
      .where("id = :id AND status IN ('pending', 'downloaded')", { id })
      .execute();
    return (result.affected ?? 0) > 0;
  }

  async setDeleted(id: string, deleted: Record<string, number>): Promise<void> {
    await this.archives.update({ id }, { deleted });
  }

  async markDone(id: string, deleted: Record<string, number>, at: string): Promise<void> {
    await this.archives.update(
      { id, status: "deleting" },
      { status: "done", deleted, deletedAt: at },
    );
  }

  /**
   * Plain `VACUUM (ANALYZE)` on this service's own tables: deleted space becomes reusable and the
   * planner sees the new row counts. Runs outside any transaction, as VACUUM must.
   */
  async vacuum(tables: readonly ("operations" | "audit_events")[]): Promise<void> {
    for (const table of tables) await this.db.query(`VACUUM (ANALYZE) "${table}"`);
  }
}
