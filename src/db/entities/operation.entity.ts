import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/** Every artefact this service can cause dpm-wallet to sign. */
export const OPERATION_KINDS = [
  "order",
  "cancel",
  "allowance",
  "redeem",
  "split",
  "merge",
  "withdraw",
] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * One row per signed artefact issued, for the backoffice UI and for incident review.
 *
 * Distinct from `audit_events`, which records *decisions* (including denials). This records
 * *artefacts*: what was signed, on whose behalf, and by which wallet — the question "who signed
 * the order behind this hash" has to be answerable months later, and in shared mode the signer is
 * not the wallet the caller named.
 *
 * `result_summary` holds an order hash or a `from`/`nonce` pair. Never a signature: a signature
 * is a bearer artefact, and this table is readable through the API.
 */
@Entity("operations")
export class OperationEntity {
  @PrimaryColumn("uuid")
  id!: string;

  /** The wallet the caller named — in shared mode, not necessarily the one that signed. */
  @Index("operations_wallet_id")
  @Column("uuid", { name: "wallet_id" })
  walletId!: string;

  @Column("uuid", { name: "signer_wallet_id" })
  signerWalletId!: string;

  @Index("operations_kind")
  @Column("text")
  kind!: OperationKind;

  /** The custody mode in force when this was signed; modes cannot change, but reads are simpler. */
  @Column("text")
  mode!: string;

  /** keccak-free: a SHA-256 of the canonical request, for correlating retries. */
  @Column("text", { name: "request_hash" })
  requestHash!: string;

  @Column("text", { name: "result_summary", nullable: true })
  resultSummary!: string | null;

  @Column("text")
  status!: string;

  @Column("uuid", { name: "api_key_id", nullable: true })
  apiKeyId!: string | null;

  /** The admin UI user behind the request, when it came from a signed-in browser. */
  @Column("uuid", { name: "ui_user_id", nullable: true })
  uiUserId!: string | null;

  @Index("operations_created_at")
  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;
}
