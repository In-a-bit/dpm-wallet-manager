import { Column, Entity, Index, PrimaryColumn } from "typeorm";

import { isoTimestamp } from "../iso-timestamp";

/** The three roles a wallet can play. Only `user` may exist more than once. */
export const WALLET_KINDS = ["user", "master", "operations"] as const;
export type WalletKind = (typeof WALLET_KINDS)[number];

/**
 * `provisioning` — the row exists but dpm-wallet has not confirmed an address yet.
 * `active`       — usable.
 * `disabled`     — retained for its history and for the platform-address check, but refused for
 *                  every signing route. Wallets are never deleted; funds may still sit at the
 *                  address, and forgetting it would turn a platform address into an external one.
 */
export const WALLET_STATUSES = ["provisioning", "active", "disabled"] as const;
export type WalletStatus = (typeof WALLET_STATUSES)[number];

/**
 * The directory the whole API is addressed by: the manager's own id, the `ref` dpm-wallet knows
 * the same wallet as, and the addresses that let the funds policy tell "ours" from "external".
 *
 * Addresses are stored EIP-55 checksummed — canonical, validated once on the way in — so a read
 * needs no normalisation. The casing-independent indices are on `lower(...)` instead of the raw
 * column, which keeps lookups working regardless; they are `synchronize: false` because an index
 * over an expression cannot be declared on an entity, so the migration creates them and this
 * tells the schema builder they are accounted for rather than drift to be dropped.
 *
 * The two partial unique indexes on `kind` are the reason there can only ever be one master and
 * one operations wallet: a second one is a database error, not a race the service has to win.
 */
@Entity("wallets")
@Index("wallets_eoa_lower", { synchronize: false })
@Index("wallets_proxy_lower", { synchronize: false })
@Index("wallets_external_lower", { synchronize: false })
@Index("wallets_one_master", { synchronize: false })
@Index("wallets_one_operations", { synchronize: false })
export class WalletEntity {
  /** Minted by the service, not the database: the ref sent upstream is derived from it. */
  @PrimaryColumn("uuid")
  id!: string;

  @Index("wallets_ref", { unique: true })
  @Column("text")
  ref!: string;

  @Index("wallets_kind")
  @Column("text")
  kind!: WalletKind;

  /** The caller's own identifier, when they supplied one. Unique case-insensitively. */
  @Column("text", { name: "external_id", nullable: true })
  externalId!: string | null;

  @Column("text", { nullable: true })
  label!: string | null;

  @Index("wallets_status")
  @Column("text")
  status!: WalletStatus;

  @Column("text", { name: "eoa_address", nullable: true })
  eoaAddress!: string | null;

  @Column("text", { name: "proxy_address", nullable: true })
  proxyAddress!: string | null;

  @Column("integer", { name: "derivation_index", nullable: true })
  derivationIndex!: number | null;

  /** Mirror of dpm-wallet's flag; meta-transaction signing upstream depends on it. */
  @Column("boolean", { name: "dpm_registered", default: false })
  dpmRegistered!: boolean;

  @Column("timestamptz", { name: "created_at", transformer: isoTimestamp })
  createdAt!: string;

  @Column("timestamptz", { name: "updated_at", transformer: isoTimestamp })
  updatedAt!: string;
}
