import { Column, Entity, Index, PrimaryGeneratedColumn, type ValueTransformer } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/** bigint comes back from the driver as a string; sizes here stay far below 2^53. */
const bigintNumber: ValueTransformer = {
  to: (value: number | null) => value,
  from: (value: string | null) => (value === null ? null : Number(value)),
};

/** One reading of the disk and the databases, taken every 15 minutes. */
@Entity("storage_samples")
export class StorageSampleEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index("storage_samples_at")
  @Column("timestamptz", { transformer: isoTimestamp })
  at!: string;

  @Column("bigint", { name: "disk_total_bytes", nullable: true, transformer: bigintNumber })
  diskTotalBytes!: number | null;

  @Column("bigint", { name: "disk_free_bytes", nullable: true, transformer: bigintNumber })
  diskFreeBytes!: number | null;

  @Column("double precision", { name: "disk_used_percent", nullable: true })
  diskUsedPercent!: number | null;

  @Column("bigint", { name: "wallet_db_bytes", nullable: true, transformer: bigintNumber })
  walletDbBytes!: number | null;

  @Column("bigint", { name: "manager_db_bytes", transformer: bigintNumber })
  managerDbBytes!: number;

  /** Stringified `[{db, name, bytes, estRows}]`. */
  @Column("text", { name: "tables_json" })
  tablesJson!: string;

  @Column("double precision", { name: "growth_bytes_per_day", nullable: true })
  growthBytesPerDay!: number | null;

  @Column("double precision", { name: "days_to_full", nullable: true })
  daysToFull!: number | null;

  @Column("text")
  level!: string;

  @Column("timestamptz", { name: "oldest_important_at", nullable: true, transformer: isoTimestamp })
  oldestImportantAt!: string | null;
}
