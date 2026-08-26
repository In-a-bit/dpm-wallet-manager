import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";

import { PaginationDto } from "../../common/dto/pagination.dto";
import { IsIsoTimestamp, IsUuid, Trimmed } from "../../common/validation/decorators";
import { OPERATION_KINDS, type OperationKind } from "../../db/entities";
import { AuditAction, AuditOutcome } from "../../observability/audit-action";

const ACTIONS = Object.values(AuditAction);
const OUTCOMES = Object.values(AuditOutcome);

/**
 * The filters an incident is actually investigated with: what happened, to which wallet, on whose
 * authority, and when. `action` is constrained to the known set so a typo comes back as a 400
 * rather than an empty page that reads like "nothing happened".
 */
export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ACTIONS, example: "meta.withdraw.external" })
  @IsOptional()
  @Trimmed()
  @IsIn(ACTIONS)
  action?: string;

  /** `denied` selects the refusals, which is where an incident usually starts. */
  @ApiPropertyOptional({ enum: OUTCOMES, example: "denied" })
  @IsOptional()
  @Trimmed()
  @IsIn(OUTCOMES)
  outcome?: string;

  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUuid()
  walletId?: string;

  /** The API key that made the request. */
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUuid()
  actorKeyId?: string;

  /** Inclusive lower bound on `createdAt`. */
  @ApiPropertyOptional({ format: "date-time", example: "2026-08-01T00:00:00Z" })
  @IsOptional()
  @IsIsoTimestamp()
  from?: string;

  /** Inclusive upper bound on `createdAt`. */
  @ApiPropertyOptional({ format: "date-time", example: "2026-09-01T00:00:00Z" })
  @IsOptional()
  @IsIsoTimestamp()
  to?: string;
}

export class OperationQueryDto extends PaginationDto {
  /** The wallet the caller named — not necessarily the one that signed. */
  @ApiPropertyOptional({ format: "uuid" })
  @IsOptional()
  @IsUuid()
  walletId?: string;

  @ApiPropertyOptional({ enum: OPERATION_KINDS, example: "order" })
  @IsOptional()
  @IsIn([...OPERATION_KINDS])
  kind?: OperationKind;

  @ApiPropertyOptional({ format: "date-time" })
  @IsOptional()
  @IsIsoTimestamp()
  from?: string;

  @ApiPropertyOptional({ format: "date-time" })
  @IsOptional()
  @IsIsoTimestamp()
  to?: string;
}
