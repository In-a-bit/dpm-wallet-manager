import { ApiProperty } from "@nestjs/swagger";

import { API_KEY_ROLES, API_KEY_STATUSES, type ApiKeyRole } from "../../db/entities";

/** A key's metadata: everything about it except the key. Safe to list, safe to log. */
export class ApiKeyDto {
  @ApiProperty({ format: "uuid", example: "9f2c1ab4-e0d7-4b38-86a1-c0ff1e2d3c4b" })
  id!: string;

  @ApiProperty({ enum: API_KEY_ROLES, example: "operator" })
  role!: ApiKeyRole;

  /** What this key is for. Shown in the key list. */
  @ApiProperty({ example: "trading-backend" })
  name!: string;

  /**
   * The non-secret handle: namespace, environment, role and the first 8 characters of the secret.
   * It is what the guard looks the key up by, what a failed-authentication log line carries, and
   * the only part of a key that is safe to display.
   */
  @ApiProperty({ example: "dpmm_live_op_2nhqg8xy" })
  prefix!: string;

  @ApiProperty({ enum: API_KEY_STATUSES, example: "active" })
  status!: string;

  /** Set on the outgoing key during a rotation's grace window. Null means it never expires. */
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  expiresAt!: string | null;

  /** Written at most once a minute per key, so authentication is not a write path. */
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastUsedAt!: string | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  revokedAt!: string | null;

  /** The key this one replaced, if it was minted by a rotation. */
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  rotatedFromId!: string | null;

  /** Null only for the bootstrap key, which by definition no key created. */
  @ApiProperty({ type: String, format: "uuid", nullable: true })
  createdByKeyId!: string | null;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;
}

/**
 * A key together with its plaintext. Returned only by create, rotate and reveal — the three
 * moments a caller is meant to copy it.
 */
export class MintedApiKeyDto extends ApiKeyDto {
  @ApiProperty({
    description:
      "The full key. Store it now: it is not recoverable from the list endpoints, only through " +
      "an explicit, audited reveal.",
    example: "dpmm_live_op_2nhqg8xyk7m2q9x4b3n8v3c6z2s5t2r7",
  })
  key!: string;
}

export class ApiKeyPageDto {
  @ApiProperty({ type: [ApiKeyDto] })
  items!: ApiKeyDto[];

  @ApiProperty({ example: 3 })
  total!: number;
}

export class RotateApiKeyResponseDto {
  /** The replacement. Deploy it before the grace window closes. */
  @ApiProperty({ type: MintedApiKeyDto })
  created!: MintedApiKeyDto;

  /** The outgoing key, now carrying an expiry — or already revoked, if the grace was zero. */
  @ApiProperty({ type: ApiKeyDto })
  rotated!: ApiKeyDto;
}

/** The answer to "which key am I?" — the UI's session probe. */
export class ActorDto {
  @ApiProperty({ format: "uuid" })
  keyId!: string;

  @ApiProperty({ enum: API_KEY_ROLES })
  role!: ApiKeyRole;

  @ApiProperty({ example: "dpmm_live_ad_tyzhy9c8" })
  prefix!: string;

  @ApiProperty({ example: "bootstrap" })
  name!: string;
}
