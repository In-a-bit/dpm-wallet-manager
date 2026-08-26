import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { ERROR_STATUS, type ErrorCode } from "../../errors";

const ERROR_CODES = Object.keys(ERROR_STATUS) as ErrorCode[];

export class ErrorBodyDto {
  /**
   * A stable, machine-readable code. Callers branch on this, not on the message or the status:
   * several codes share a status, and the messages are free to change.
   */
  @ApiProperty({ enum: ERROR_CODES, example: "EXTERNAL_TRANSFER_FORBIDDEN" })
  code!: ErrorCode;

  /** Human-readable, and safe to show an operator. Never contains a credential. */
  @ApiProperty({
    example: "Funds may only leave the platform from the master wallet",
  })
  message!: string;

  /**
   * Whatever the caller needs to act on the error: the offending validation paths, the wallet id,
   * or the upstream code behind an `UPSTREAM_*`.
   */
  @ApiPropertyOptional({
    type: "object",
    additionalProperties: true,
    example: { walletId: "b7b834cf-f233-4d77-ad65-4a55409f2248", walletKind: "user" },
  })
  details?: Record<string, unknown>;
}

/** The single error shape every endpoint returns, matching dpm-wallet's own envelope. */
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;
}
