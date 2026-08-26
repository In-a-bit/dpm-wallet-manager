import { ApiProperty } from "@nestjs/swagger";

/**
 * Deliberately shallow: this answers "is the process up", nothing more. Anything a caller would
 * act on — the mode, whether dpm-wallet is answering, whether the platform wallets exist — lives
 * on `GET /v1/platform`, which is authenticated.
 */
export class HealthResponseDto {
  @ApiProperty({ example: "ok" })
  status!: string;
}
