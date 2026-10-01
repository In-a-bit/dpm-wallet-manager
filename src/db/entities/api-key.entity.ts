import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * Each role reaches everything the next one does, and more: `admin` ⊃ `operator` ⊃ `readonly`.
 * `readonly` reads (wallets, platform status, the audit and operations logs) and nothing else.
 */
export const API_KEY_ROLES = ["admin", "operator", "readonly"] as const;
export type ApiKeyRole = (typeof API_KEY_ROLES)[number];

export const API_KEY_STATUSES = ["active", "revoked"] as const;
export type ApiKeyStatus = (typeof API_KEY_STATUSES)[number];

/**
 * A credential, stored twice over: as an HMAC for verification and as an AES-256-GCM envelope so
 * an admin can reveal it later. The plaintext itself is never written.
 *
 * `prefix` is the non-secret handle — it identifies the row for the guard's single indexed
 * lookup, gives the UI something to display, and is what a failed-auth log line carries.
 */
@Entity("api_keys")
export class ApiKeyEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Index("api_keys_role")
  @Column("text")
  role!: ApiKeyRole;

  @Column("text")
  name!: string;

  @Index("api_keys_prefix", { unique: true })
  @Column("text")
  prefix!: string;

  /** HMAC-SHA256 of the full key under the derived pepper, hex. */
  @Column("text")
  hash!: string;

  /** `v1.<iv>.<tag>.<ciphertext>` — the reveal source. */
  @Column("text", { name: "secret_encrypted" })
  secretEncrypted!: string;

  @Index("api_keys_status")
  @Column("text")
  status!: ApiKeyStatus;

  /** Set on the outgoing key during a rotation grace period; NULL means it never expires. */
  @Column("timestamptz", { name: "expires_at", nullable: true, transformer: isoTimestamp })
  expiresAt!: string | null;

  /** Written at most once a minute per key, so the hot path is not a write path. */
  @Column("timestamptz", { name: "last_used_at", nullable: true, transformer: isoTimestamp })
  lastUsedAt!: string | null;

  @Column("timestamptz", { name: "revoked_at", nullable: true, transformer: isoTimestamp })
  revokedAt!: string | null;

  /** Rotation lineage, so the UI can show which key replaced which. */
  @Column("uuid", { name: "rotated_from_id", nullable: true })
  rotatedFromId!: string | null;

  /** NULL for the bootstrap key, which by definition no key created, and for a UI user's key. */
  @Column("uuid", { name: "created_by_key_id", nullable: true })
  createdByKeyId!: string | null;

  /** The admin UI user who created the key, when one did. */
  @Column("uuid", { name: "created_by_user_id", nullable: true })
  createdByUserId!: string | null;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
