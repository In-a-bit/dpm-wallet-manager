import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * A signed-in browser. Kept server-side rather than in a self-contained token so that disabling a
 * user or changing a password ends their sessions at once, instead of when a token expires.
 *
 * Only a SHA-256 of the cookie's token is stored: someone who can read this table still cannot
 * sign in as anyone.
 */
@Entity("ui_sessions")
export class UiSessionEntity {
  @PrimaryColumn("uuid")
  id!: string;

  @Index("ui_sessions_token_hash", { unique: true })
  @Column("text", { name: "token_hash" })
  tokenHash!: string;

  @Index("ui_sessions_user_id")
  @Column("uuid", { name: "user_id" })
  userId!: string;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;

  /** Written at most once a minute per session, like an API key's `last_used_at`. */
  @Column("timestamptz", { name: "last_seen_at", transformer: isoTimestamp })
  lastSeenAt!: string;

  /** The absolute limit; the idle limit is measured from `last_seen_at`. */
  @Index("ui_sessions_expires_at")
  @Column("timestamptz", { name: "expires_at", transformer: isoTimestamp })
  expiresAt!: string;

  @Column("text", { nullable: true })
  ip!: string | null;

  @Column("text", { name: "user_agent", nullable: true })
  userAgent!: string | null;
}
