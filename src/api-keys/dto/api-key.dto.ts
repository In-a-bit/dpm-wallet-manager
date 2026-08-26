import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, Max, Min } from "class-validator";

import { IsIsoTimestamp, IsLabel } from "../../common/validation/decorators";
import { API_KEY_ROLES, type ApiKeyRole } from "../../db/entities";

export class CreateApiKeyDto {
  /** `admin` is a superset of `operator`: it reaches everything an operator key does, and more. */
  @ApiProperty({ enum: API_KEY_ROLES, example: "operator" })
  @IsIn([...API_KEY_ROLES])
  role!: ApiKeyRole;

  /** What this key is for. Shown in the key list; the only way to tell two keys apart at a glance. */
  @ApiProperty({ maxLength: 200, example: "trading-backend" })
  @IsLabel()
  name!: string;

  /** Optional deadline. Omit for a key that never expires on its own. */
  @ApiPropertyOptional({ format: "date-time", example: "2027-01-01T00:00:00Z" })
  @IsOptional()
  @IsIsoTimestamp()
  expiresAt?: string;
}

/** A week is the default overlap: long enough to redeploy every caller without a scramble. */
const DEFAULT_GRACE_SECONDS = 7 * 24 * 60 * 60;
const MAX_GRACE_SECONDS = 30 * 24 * 60 * 60;

export class RotateApiKeyDto {
  /**
   * How long the outgoing key keeps working. `0` revokes it immediately, which is the right
   * choice when the reason for rotating is that the key leaked.
   */
  @ApiPropertyOptional({
    minimum: 0,
    maximum: MAX_GRACE_SECONDS,
    default: DEFAULT_GRACE_SECONDS,
    example: 3600,
  })
  @IsInt()
  @Min(0)
  @Max(MAX_GRACE_SECONDS)
  graceSeconds: number = DEFAULT_GRACE_SECONDS;
}
