import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional } from "class-validator";

import type { SettingSource } from "../retention-settings.service";

const SOURCES = ["default", "environment", "dashboard"] as const;

/*
 * The request DTOs only declare which keys exist; the services own the value checks, because
 * the bounds depend on what is in force after the patch (warning below critical, and so on) and
 * must produce the same VALIDATION_FAILED shape whichever caller reaches them.
 */

export class RetentionSourcesDto {
  @ApiProperty({ enum: SOURCES, example: "environment" })
  enabled!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "environment" })
  routineDays!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "dashboard" })
  routedOrderDays!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "default" })
  archiveReminderDays!: SettingSource;
}

export class RetentionFixedDto {
  /** How long an idempotency record is kept. Not configurable. */
  @ApiProperty({ example: 24 })
  idempotencyHours!: number;

  /** Container log rotation. Not configurable here. */
  @ApiProperty({ example: "5 × 20 MB per service" })
  logs!: string;
}

export class RetentionValuesDto {
  @ApiProperty({ example: true })
  enabled!: boolean;
  @ApiProperty({ example: 90 })
  routineDays!: number;
  @ApiProperty({ example: 365 })
  routedOrderDays!: number;
  @ApiProperty({ example: 730 })
  archiveReminderDays!: number;
}

export class RetentionSettingsDto {
  /** Whether the hourly trimming runs at all. */
  @ApiProperty({ example: true })
  enabled!: boolean;

  /** Routine records older than this are deleted. 1 to 3650. */
  @ApiProperty({ example: 90 })
  routineDays!: number;

  /** Routed orders (signed by another wallet) are kept this long. Not below `routineDays`. */
  @ApiProperty({ example: 365 })
  routedOrderDays!: number;

  /** Important records older than this make the dashboard suggest an archive. */
  @ApiProperty({ example: 730 })
  archiveReminderDays!: number;

  @ApiProperty({ type: RetentionSourcesDto })
  sources!: RetentionSourcesDto;

  /** What each key reverts to when cleared. */
  @ApiProperty({ type: RetentionValuesDto })
  defaults!: RetentionValuesDto;

  @ApiProperty({ type: RetentionFixedDto })
  fixed!: RetentionFixedDto;
}

export class UpdateRetentionSettingsDto {
  /** `null` reverts to the environment default. */
  @ApiPropertyOptional({ type: Boolean, nullable: true, example: true })
  @IsOptional()
  enabled?: boolean | null;

  /** `null` reverts to the environment default. */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 90 })
  @IsOptional()
  routineDays?: number | null;

  /** `null` reverts to the environment default. */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 365 })
  @IsOptional()
  routedOrderDays?: number | null;

  /** `null` reverts to the default (730). */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 730 })
  @IsOptional()
  archiveReminderDays?: number | null;
}

export class StorageSourcesDto {
  @ApiProperty({ enum: SOURCES, example: "default" })
  warningPercent!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "default" })
  warningDays!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "dashboard" })
  criticalPercent!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "default" })
  criticalDays!: SettingSource;
  @ApiProperty({ enum: SOURCES, example: "default" })
  alertWebhookUrl!: SettingSource;
}

export class StorageSettingsDto {
  /** Disk usage at which storage is flagged as a warning. 1 to 99, below `criticalPercent`. */
  @ApiProperty({ example: 75 })
  warningPercent!: number;

  /** Days of disk left, at the current growth, that flag a warning. 1 to 365, above `criticalDays`. */
  @ApiProperty({ example: 30 })
  warningDays!: number;

  /** Disk usage at which storage is flagged as critical. 1 to 99. */
  @ApiProperty({ example: 90 })
  criticalPercent!: number;

  /** Days of disk left that flag critical. 1 to 365. */
  @ApiProperty({ example: 7 })
  criticalDays!: number;

  /**
   * Where storage alerts are posted; `null` when none is set. Admins get the full URL; every
   * other role gets only its origin followed by `/…`, because the path often holds a secret.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    example: "https://hooks.example.com/storage",
  })
  alertWebhookUrl!: string | null;

  /** Whether a webhook is set. The only webhook information a non-admin caller gets besides the masked URL. */
  @ApiProperty({ example: true })
  alertWebhookConfigured!: boolean;

  @ApiProperty({ type: StorageSourcesDto })
  sources!: StorageSourcesDto;
}

export class UpdateStorageSettingsDto {
  /** `null` reverts to the default (75). */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 75 })
  @IsOptional()
  warningPercent?: number | null;

  /** `null` reverts to the default (30). */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 30 })
  @IsOptional()
  warningDays?: number | null;

  /** `null` reverts to the default (90). */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 90 })
  @IsOptional()
  criticalPercent?: number | null;

  /** `null` reverts to the default (7). */
  @ApiPropertyOptional({ type: Number, nullable: true, example: 7 })
  @IsOptional()
  criticalDays?: number | null;

  /** An http or https URL, or `null` to remove it. */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    example: "https://hooks.example.com/storage",
  })
  @IsOptional()
  alertWebhookUrl?: string | null;
}
