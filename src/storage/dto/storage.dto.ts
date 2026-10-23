import { ApiProperty } from "@nestjs/swagger";

const LEVELS = ["ok", "warning", "critical"] as const;

export class StorageDiskDto {
  @ApiProperty({ example: 500_000_000_000 })
  totalBytes!: number;
  @ApiProperty({ example: 200_000_000_000 })
  freeBytes!: number;
  @ApiProperty({ example: 60 })
  usedPercent!: number;
}

export class StorageDatabasesDto {
  /** dpm-wallet's database; null where it cannot be seen. */
  @ApiProperty({ type: Number, nullable: true, example: 120_000_000 })
  wallet!: number | null;
  @ApiProperty({ example: 340_000_000 })
  manager!: number;
}

export class StorageTableDto {
  @ApiProperty({ example: "manager" })
  db!: string;
  @ApiProperty({ example: "operations" })
  name!: string;
  @ApiProperty({ example: 52_000_000 })
  bytes!: number;
  @ApiProperty({ example: 120_000 })
  estRows!: number;
}

export class StorageTightenedDto {
  /** Days routine records are kept right now because the disk is under pressure. */
  @ApiProperty({ example: 30 })
  routineDays!: number;
  @ApiProperty({ example: "2026-10-23T08:00:00.000Z" })
  since!: string;
}

export class StorageStatusDto {
  @ApiProperty({ example: "2026-10-23T08:00:00.000Z" })
  at!: string;
  /** Null when the Postgres volume is not mounted; the level is then ok. */
  @ApiProperty({ type: StorageDiskDto, nullable: true })
  disk!: StorageDiskDto | null;
  @ApiProperty({ type: StorageDatabasesDto })
  databases!: StorageDatabasesDto;
  /** This service's own tables only; dpm-wallet's database cannot be queried from here. */
  @ApiProperty({ type: [StorageTableDto] })
  tables!: StorageTableDto[];
  @ApiProperty({ type: Number, nullable: true, example: 120_000_000 })
  growthBytesPerDay!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 90.5 })
  daysToFull!: number | null;
  @ApiProperty({ enum: LEVELS, example: "ok" })
  level!: "ok" | "warning" | "critical";
  @ApiProperty({ type: StorageTightenedDto, nullable: true })
  tightened!: StorageTightenedDto | null;
  /** Oldest withdraw or non-routine audit event in this service's database. */
  @ApiProperty({ type: String, nullable: true, example: "2025-01-02T03:04:05.000Z" })
  oldestImportantAt!: string | null;
  @ApiProperty({ example: false })
  archiveSuggested!: boolean;
}
