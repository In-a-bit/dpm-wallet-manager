import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

/**
 * Deliberately shallow: this answers "is the process up", nothing more. Anything a caller would
 * act on — the mode, whether dpm-wallet is answering, whether the platform wallets exist — lives
 * on `GET /v1/platform`, which is authenticated.
 */
export class HealthResponseDto {
  @ApiProperty({ example: "ok" })
  status!: string;
}

export class HealthStorageDto {
  @ApiProperty({ enum: ["ok", "warning", "critical"], example: "ok" })
  level!: string;
  @ApiProperty({ type: Number, nullable: true, example: 61.5 })
  usedPercent!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 90 })
  daysToFull!: number | null;
}

export class ReadyResponseDto extends HealthResponseDto {
  /** From the latest storage sample; absent when there is none yet. Never affects the status. */
  @ApiPropertyOptional({ type: HealthStorageDto })
  storage?: HealthStorageDto;
}
