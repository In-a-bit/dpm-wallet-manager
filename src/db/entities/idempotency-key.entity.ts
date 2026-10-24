import { Column, Entity, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * Replay protection for POST endpoints. Survives restart, so a client retrying across one gets
 * the original response instead of a second signature. Keyed by the actor as well as the key, so
 * one caller can neither replay nor probe another's keys.
 */
@Entity("idempotency_keys")
export class IdempotencyKeyEntity {
  /** The API key id, or `user:<id>` for a signed-in UI user. */
  @PrimaryColumn("text")
  actor!: string;

  @PrimaryColumn("text")
  key!: string;

  @Column("text", { name: "request_hash" })
  requestHash!: string;

  @Column("text", { name: "response_json" })
  responseJson!: string;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
