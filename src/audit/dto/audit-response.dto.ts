import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { OPERATION_KINDS } from "../../db/entities";
import { AuditAction, AuditOutcome } from "../../observability/audit-action";

/** One decision: who asked for what, and whether it was permitted. */
export class AuditEventDto {
  @ApiProperty({ example: 42 })
  id!: number;

  /** The API key behind the request. Null for a decision no request caused, such as the boot-time mode burn. */
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  actorKeyId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "admin" })
  actorRole!: string | null;

  /** The admin UI user behind the request. Null for an API key or a decision no request caused. */
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  actorUserId!: string | null;

  /** That user's name at the time, so the trail still reads right after an account changes. */
  @ApiProperty({ type: String, nullable: true, example: "alice" })
  actorUsername!: string | null;

  @ApiProperty({ type: String, format: "uuid", nullable: true })
  walletId!: string | null;

  /** `meta.withdraw.external` is the one action that means money left the platform. */
  @ApiProperty({ enum: Object.values(AuditAction), example: "meta.withdraw.external" })
  action!: string;

  /** `denied` matters as much as `success`: a refused withdrawal is where an incident starts. */
  @ApiProperty({ enum: Object.values(AuditOutcome), example: "success" })
  outcome!: string;

  /** Redacted before it is stored: this is readable over the API and never holds a credential. */
  @ApiProperty({ type: "object", additionalProperties: true, nullable: true })
  detail!: Record<string, unknown> | null;

  /** Correlates this event with the request line in the service's own logs. */
  @ApiProperty({ type: String, nullable: true })
  requestId!: string | null;

  /** The caller's address, as the proxy in front of this service reported it. */
  @ApiProperty({ type: String, nullable: true })
  ip!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class AuditPageDto {
  @ApiProperty({ type: [AuditEventDto] })
  items!: AuditEventDto[];

  @ApiProperty({ example: 512 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}

/** One signed artefact: what was signed, on whose behalf, and by which wallet. */
export class OperationDto {
  @ApiProperty({ format: "uuid" })
  id!: string;

  /** The wallet the caller named. */
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  /**
   * The wallet whose key signed. In shared mode a BUY is signed by the treasury, so this is the
   * only place the question "which wallet signed the order behind this hash" is answerable.
   */
  @ApiProperty({ format: "uuid" })
  signerWalletId!: string;

  @ApiProperty({ enum: OPERATION_KINDS, example: "order" })
  kind!: string;

  /** The custody mode in force when this was signed. */
  @ApiProperty({ example: "shared" })
  mode!: string;

  /** SHA-256 of the canonical request, for correlating retries. */
  @ApiProperty({ example: "9f2c1ab4e0d75b38…" })
  requestHash!: string;

  /**
   * An order hash, or a `from:nonce` pair for a meta-transaction. Never a signature — this table
   * is readable over the API, and a signature is a bearer artefact.
   */
  @ApiProperty({ type: String, nullable: true, example: "0x4d97dcd97ec945f4…" })
  resultSummary!: string | null;

  @ApiProperty({ example: "signed" })
  status!: string;

  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  apiKeyId!: string | null;

  /** The admin UI user behind the request, when it came from a signed-in browser. */
  @ApiPropertyOptional({ type: String, format: "uuid", nullable: true })
  uiUserId!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

export class OperationPageDto {
  @ApiProperty({ type: [OperationDto] })
  items!: OperationDto[];

  @ApiProperty({ example: 512 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}
