import { Column, Entity, Index, PrimaryGeneratedColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * The decision log: every privileged action, allowed or denied, with the key that asked for it.
 *
 * Append-only, and never holds a usable credential — the writer redacts before a row is built.
 * Denials matter as much as approvals here: "an operator key tried to withdraw to an unknown
 * address" is the event an incident starts from.
 */
@Entity("audit_events")
export class AuditEventEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Index("audit_events_actor_key_id")
  @Column("uuid", { name: "actor_key_id", nullable: true })
  actorKeyId!: string | null;

  @Column("text", { name: "actor_role", nullable: true })
  actorRole!: string | null;

  /** The admin UI user behind the request, when it came from a signed-in browser. */
  @Index("audit_events_actor_user_id")
  @Column("uuid", { name: "actor_user_id", nullable: true })
  actorUserId!: string | null;

  /** Copied at the time, so the trail still reads right after an account is renamed or removed. */
  @Column("text", { name: "actor_username", nullable: true })
  actorUsername!: string | null;

  @Index("audit_events_wallet_id")
  @Column("uuid", { name: "wallet_id", nullable: true })
  walletId!: string | null;

  @Index("audit_events_action")
  @Column("text")
  action!: string;

  @Index("audit_events_outcome")
  @Column("text")
  outcome!: string;

  /** Redacted JSON, stringified by the repository so a hand-edited row cannot break a read. */
  @Column("text", { nullable: true })
  detail!: string | null;

  /** Correlates the event with the request line in the logs. */
  @Column("text", { name: "request_id", nullable: true })
  requestId!: string | null;

  @Column("text", { nullable: true })
  ip!: string | null;

  @Index("audit_events_created_at")
  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
