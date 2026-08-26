import { Inject, Injectable } from "@nestjs/common";
import type { Repository } from "typeorm";
import { getAddress, type Address } from "viem";

import { DB } from "../../tokens";
import type { Db, Executor } from "../client";
import { WalletEntity, type WalletKind, type WalletStatus } from "../entities";

export type Wallet = {
  id: string;
  ref: string;
  kind: WalletKind;
  externalId: string | null;
  label: string | null;
  status: WalletStatus;
  /** Null only while `status` is `provisioning`. */
  eoaAddress: Address | null;
  proxyAddress: Address | null;
  derivationIndex: number | null;
  dpmRegistered: boolean;
  createdAt: string;
  updatedAt: string;
};

/** A wallet whose upstream address is confirmed — the only shape the signing routes accept. */
export type ReadyWallet = Wallet & { eoaAddress: Address; proxyAddress: Address };

export type NewWallet = {
  id: string;
  ref: string;
  kind: WalletKind;
  externalId: string | null;
  label: string | null;
  createdAt: string;
};

export type WalletFilter = {
  kind?: WalletKind;
  status?: WalletStatus;
  /** Substring match over ref, external id, label and both addresses. */
  q?: string;
};

export type WalletPage = { wallets: Wallet[]; total: number };

@Injectable()
export class WalletRepository {
  private readonly wallets: Repository<WalletEntity>;

  constructor(@Inject(DB) db: Db) {
    this.wallets = db.getRepository(WalletEntity);
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const row = await this.wallets.findOneBy({ id });
    return row ? toWallet(row) : undefined;
  }

  async findByRef(ref: string): Promise<Wallet | undefined> {
    const row = await this.wallets.findOneBy({ ref });
    return row ? toWallet(row) : undefined;
  }

  async findByExternalId(externalId: string): Promise<Wallet | undefined> {
    const row = await this.wallets
      .createQueryBuilder("w")
      .where("lower(w.external_id) = lower(:externalId)", { externalId })
      .getOne();
    return row ? toWallet(row) : undefined;
  }

  /** The singleton lookup for `master` and `operations`. */
  async findByKind(kind: WalletKind): Promise<Wallet | undefined> {
    const row = await this.wallets.findOneBy({ kind });
    return row ? toWallet(row) : undefined;
  }

  /**
   * The funds-policy question, asked on every value-moving signature: does this address belong to
   * the platform? Matches either address column case-insensitively, hitting the `lower(...)`
   * indexes. Disabled wallets count — funds may still sit at the address, and treating it as
   * external would let a transfer to it be refused for the wrong reason.
   */
  async isPlatformAddress(address: string): Promise<boolean> {
    const count = await this.wallets
      .createQueryBuilder("w")
      .where("lower(w.eoa_address) = lower(:address)", { address })
      .orWhere("lower(w.proxy_address) = lower(:address)", { address })
      .getCount();
    return count > 0;
  }

  async list(filter: WalletFilter, limit: number, offset: number): Promise<WalletPage> {
    const query = this.wallets.createQueryBuilder("w");
    if (filter.kind) query.andWhere("w.kind = :kind", { kind: filter.kind });
    if (filter.status) query.andWhere("w.status = :status", { status: filter.status });
    if (filter.q) {
      query.andWhere(
        "(w.ref ILIKE :q OR w.external_id ILIKE :q OR w.label ILIKE :q OR w.eoa_address ILIKE :q OR w.proxy_address ILIKE :q)",
        { q: `%${filter.q}%` },
      );
    }
    const [rows, total] = await query
      .orderBy("w.created_at", "DESC")
      .addOrderBy("w.id", "DESC")
      .take(limit)
      .skip(offset)
      .getManyAndCount();
    return { wallets: rows.map(toWallet), total };
  }

  /** Rows stuck mid-provisioning, for the boot sweep and the reconcile endpoint. */
  async listProvisioning(): Promise<Wallet[]> {
    const rows = await this.wallets.findBy({ status: "provisioning" });
    return rows.map(toWallet);
  }

  /**
   * Records the intent to mint an address before anything is minted. The row is written first and
   * committed on its own, so a crash during the upstream call leaves a `provisioning` row to
   * reconcile rather than an address nobody knows about.
   */
  async insertProvisioning(wallet: NewWallet, executor?: Executor): Promise<Wallet> {
    const repo = executor ? executor.getRepository(WalletEntity) : this.wallets;
    const row = await repo.save(
      repo.create({
        id: wallet.id,
        ref: wallet.ref,
        kind: wallet.kind,
        externalId: wallet.externalId,
        label: wallet.label,
        status: "provisioning",
        eoaAddress: null,
        proxyAddress: null,
        derivationIndex: null,
        dpmRegistered: false,
        createdAt: wallet.createdAt,
        updatedAt: wallet.createdAt,
      }),
    );
    return toWallet(row);
  }

  /**
   * Completes provisioning. The one place addresses are canonicalised: `getAddress` rejects a
   * malformed or mis-checksummed value here, at the boundary, so every later read — including the
   * policy comparison — is a plain fetch of a value already known to be well-formed.
   */
  async markProvisioned(
    id: string,
    provisioned: {
      eoaAddress: string;
      proxyAddress: string;
      derivationIndex: number;
      dpmRegistered: boolean;
    },
    now: string,
  ): Promise<Wallet | undefined> {
    await this.wallets.update(
      { id },
      {
        eoaAddress: getAddress(provisioned.eoaAddress),
        proxyAddress: getAddress(provisioned.proxyAddress),
        derivationIndex: provisioned.derivationIndex,
        dpmRegistered: provisioned.dpmRegistered,
        status: "active",
        updatedAt: now,
      },
    );
    return this.findById(id);
  }

  async setDpmRegistered(
    id: string,
    registered: boolean,
    now: string,
  ): Promise<Wallet | undefined> {
    await this.wallets.update({ id }, { dpmRegistered: registered, updatedAt: now });
    return this.findById(id);
  }

  async update(
    id: string,
    changes: { label?: string | null; status?: WalletStatus },
    now: string,
  ): Promise<Wallet | undefined> {
    await this.wallets.update({ id }, { ...changes, updatedAt: now });
    return this.findById(id);
  }

  async count(): Promise<number> {
    return this.wallets.count();
  }
}

function toWallet(row: WalletEntity): Wallet {
  return {
    id: row.id,
    ref: row.ref,
    kind: row.kind,
    externalId: row.externalId,
    label: row.label,
    status: row.status,
    eoaAddress: row.eoaAddress as Address | null,
    proxyAddress: row.proxyAddress as Address | null,
    derivationIndex: row.derivationIndex,
    dpmRegistered: row.dpmRegistered,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Narrows a wallet to one whose addresses are known. Callers use it instead of `!` assertions. */
export function isReady(wallet: Wallet): wallet is ReadyWallet {
  return (
    wallet.status !== "provisioning" && wallet.eoaAddress !== null && wallet.proxyAddress !== null
  );
}
