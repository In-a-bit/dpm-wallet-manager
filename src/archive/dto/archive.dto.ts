import { ApiProperty } from "@nestjs/swagger";
import { IsString, MaxLength } from "class-validator";

import { IsIsoTimestamp, Trimmed } from "../../common/validation/decorators";
import { ARCHIVE_STATUSES, type ArchiveStatus } from "../../db/entities";

const SCOPE_EXAMPLE = {
  "manager.operations": { maxId: 1520, rows: 37 },
  "manager.audit_events": { maxId: 88213, rows: 4211 },
  "wallet.audit_events": { maxId: 90544, rows: 812 },
};

const COUNTS_EXAMPLE = {
  "manager.operations": 37,
  "manager.audit_events": 4211,
  "wallet.audit_events": 812,
};

export class CreateArchiveDto {
  /** The cutoff: important records created before it are archived. At least 1 day ago. */
  @ApiProperty({ format: "date-time", example: "2026-07-01T00:00:00Z" })
  @IsIsoTimestamp()
  before!: string;
}

export class ArchivePreviewQueryDto {
  /** The cutoff to count for. At least 1 day ago. */
  @ApiProperty({ format: "date-time", example: "2026-07-01T00:00:00Z" })
  @IsIsoTimestamp()
  before!: string;
}

export class DeleteArchiveDto {
  /** The 6-character code from the archive's file name; case does not matter. */
  @ApiProperty({ example: "3F9A1C" })
  @Trimmed()
  @IsString()
  @MaxLength(32)
  code!: string;
}

export class ArchivePreviewDto {
  /** Rows per table an archive cut now would cover. */
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "integer" },
    example: COUNTS_EXAMPLE,
  })
  tables!: Record<string, number>;
}

export class ArchiveCreatedDto {
  @ApiProperty({ format: "uuid", example: "3f9a1c2e-7b44-4c1d-9d0e-6a3b5c7d8e9f" })
  id!: string;

  /** The id's first 6 characters, upper-cased: in the file name, and typed to confirm a delete. */
  @ApiProperty({ example: "3F9A1C" })
  code!: string;

  /**
   * Per table, the highest id in scope and the row count, fixed now. For `manager.operations`,
   * `maxId` is the row's insertion sequence number, as its ids are uuids.
   */
  @ApiProperty({ type: "object", additionalProperties: true, example: SCOPE_EXAMPLE })
  scope!: Record<string, { maxId: number; rows: number }>;
}

export class ArchiveDeleteAcceptedDto {
  @ApiProperty({ enum: ["deleting"], example: "deleting" })
  status!: "deleting";
}

export class ArchiveDto extends ArchiveCreatedDto {
  @ApiProperty({ format: "date-time", example: "2026-07-01T00:00:00.000Z" })
  before!: string;

  @ApiProperty({ enum: ARCHIVE_STATUSES, example: "downloaded" })
  status!: ArchiveStatus;

  /** SHA-256 (hex) of the gzipped file as last downloaded completely. */
  @ApiProperty({ type: String, nullable: true, example: "9b74c9897bac770ffc029102a200c5de" })
  sha256!: string | null;

  @ApiProperty({ type: Number, nullable: true, example: 183_422 })
  byteSize!: number | null;

  /** Rows in the file, across all tables (the manifest line not counted). */
  @ApiProperty({ type: Number, nullable: true, example: 5060 })
  rowCount!: number | null;

  /** Rows deleted per table so far; null until the delete starts. */
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "integer" },
    nullable: true,
    example: COUNTS_EXAMPLE,
  })
  deleted!: Record<string, number> | null;

  /** The admin UI user who created it, when it came from a signed-in browser. */
  @ApiProperty({ type: String, format: "uuid", nullable: true, example: null })
  createdByUserId!: string | null;

  /** The API key that created it, when it did not come from the admin UI. */
  @ApiProperty({ type: String, format: "uuid", nullable: true, example: null })
  createdByKeyId!: string | null;

  @ApiProperty({ format: "date-time", example: "2026-10-23T08:00:00.000Z" })
  createdAt!: string;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null })
  downloadedAt!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true, example: null })
  deletedAt!: string | null;
}

export class ArchivePageDto {
  @ApiProperty({ type: [ArchiveDto] })
  items!: ArchiveDto[];

  @ApiProperty({ example: 3 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
