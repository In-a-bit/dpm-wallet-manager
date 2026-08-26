import { Column, Entity, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/**
 * Replay protection for POST endpoints. Survives restart, so a client retrying across one gets
 * the original response instead of a second signature.
 */
@Entity("idempotency_keys")
export class IdempotencyKeyEntity {
  @PrimaryColumn("text")
  key!: string;

  @Column("text", { name: "request_hash" })
  requestHash!: string;

  @Column("text", { name: "response_json" })
  responseJson!: string;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
