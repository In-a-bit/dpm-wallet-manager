import { Column, Entity, Index, PrimaryColumn, type ValueTransformer } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

export const ARCHIVE_STATUSES = ["pending", "downloaded", "deleting", "done"] as const;
export type ArchiveStatus = (typeof ARCHIVE_STATUSES)[number];

/** Per table: the id (or, for `manager.operations`, the `seq`) ceiling and the row count. */
export type ArchiveScope = Record<string, { maxId: number; rows: number }>;

/** bigint comes back from the driver as a string; file sizes stay far below 2^53. */
const bigintNumber: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/**
 * One export of important records, and whether its rows have been removed. Never trimmed: it is
 * the only record of what an archive took out of the database.
 */
@Entity("archives")
export class ArchiveEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Column("timestamptz", { transformer: isoTimestamp })
  before!: string;

  @Column("jsonb")
  scope!: ArchiveScope;

  @Column("text")
  status!: ArchiveStatus;

  /** SHA-256 (hex) of the gzipped bytes of the last complete download. */
  @Column("text", { nullable: true })
  sha256!: string | null;

  @Column("bigint", { name: "byte_size", nullable: true, transformer: bigintNumber })
  byteSize!: number | null;

  @Column("integer", { name: "row_count", nullable: true })
  rowCount!: number | null;

  /** Rows deleted per table, updated after every batch. */
  @Column("jsonb", { nullable: true })
  deleted!: Record<string, number> | null;

  @Column("uuid", { name: "created_by_user_id", nullable: true })
  createdByUserId!: string | null;

  @Column("uuid", { name: "created_by_key_id", nullable: true })
  createdByKeyId!: string | null;

  @Index("archives_created_at")
  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;

  @Column("timestamptz", { name: "downloaded_at", nullable: true, transformer: isoTimestamp })
  downloadedAt!: string | null;

  @Column("timestamptz", { name: "deleted_at", nullable: true, transformer: isoTimestamp })
  deletedAt!: string | null;
}
