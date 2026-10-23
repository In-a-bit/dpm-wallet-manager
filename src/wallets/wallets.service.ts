import { randomUUID } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";

import {
  DpmWalletClient,
  UpstreamError,
  UPSTREAM_REF_ALREADY_EXISTS,
} from "../clients/dpm-wallet.client";
import type { UpstreamAddress, UpstreamAttestation } from "../clients/dpm-wallet.types";
import type { Actor } from "../common/actor";
import type { Config } from "../config";
import type { WalletKind } from "../db/entities";
import {
  isReady,
  WalletRepository,
  type ReadyWallet,
  type Wallet,
  type WalletFilter,
  type WalletPage,
} from "../db/repositories/wallet.repo";
import { ManagerError, walletDisabled, walletNotFound, walletNotReady } from "../errors";
import { logWarn } from "../observability/log";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { CONFIG } from "../tokens";

/** Postgres' unique-violation code, the one an `EXTERNAL_ID_TAKEN` arrives as. */
const UNIQUE_VIOLATION = "23505";

/**
 * The wallets this service registers with the DPM platform itself, as it creates them: the
 * master wallet, the only exit, and the operations wallet, which funds users (segregated) or
 * trades for them (shared). Both move funds only through relayer-api, which relays only for
 * registered addresses. User wallets join the platform when the operator decides, through the
 * attestation flow.
 */
const PLATFORM_KINDS: ReadonlySet<WalletKind> = new Set(["master", "operations"]);

@Injectable()
export class WalletsService {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly upstream: DpmWalletClient,
    private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Mints a wallet in three steps, in this order and no other:
   *
   *   1. write the row as `provisioning` and commit it,
   *   2. ask dpm-wallet for an address, keyed by the row's own id,
   *   3. write the address back and mark the row active.
   *
   * The order is the whole point. Minting upstream first and recording afterwards would, on a
   * crash in between, leave an address holding customer funds that this service has no record of
   * — unrecoverable without reading dpm-wallet's directory by hand. This way a crash leaves a
   * `provisioning` row, and because `ref` is derived from the row id, retrying is a no-op
   * upstream: `REF_ALREADY_EXISTS` means "already minted, go read it".
   */
  async create(
    input: { kind?: WalletKind; externalId?: string | undefined; label?: string | undefined },
    actor: Actor,
  ): Promise<Wallet> {
    const kind = input.kind ?? "user";
    const id = randomUUID();
    const created = await this.insert({
      id,
      ref: `${this.config.walletRefPrefix}${id}`,
      kind,
      externalId: input.externalId ?? null,
      label: input.label ?? null,
      createdAt: new Date().toISOString(),
    });

    const wallet = await this.provision(created);
    await this.audit.record({
      actor,
      walletId: wallet.id,
      action: kindAction(kind),
      outcome: AuditOutcome.Success,
      detail: {
        kind,
        externalId: wallet.externalId,
        address: wallet.eoaAddress,
        proxyAddress: wallet.proxyAddress,
      },
    });
    return wallet;
  }

  /**
   * Finishes a provisioning that did not complete, whether because this process died mid-call or
   * because dpm-wallet was briefly unreachable. Safe to call on an already-active wallet, which
   * is what lets the boot sweep run it over every `provisioning` row without checking first.
   */
  async reconcile(id: string, actor?: Actor): Promise<Wallet> {
    const wallet = await this.require(id);
    if (wallet.status !== "provisioning") return this.registerIfPlatform(wallet);

    const reconciled = await this.provision(wallet);
    await this.audit.record({
      actor,
      walletId: id,
      action: AuditAction.WalletReconcile,
      outcome: AuditOutcome.Success,
      detail: { address: reconciled.eoaAddress, proxyAddress: reconciled.proxyAddress },
    });
    return reconciled;
  }

  /** Run at boot: a container that died mid-provision finishes the job before serving traffic. */
  async reconcileAll(): Promise<number> {
    const stuck = await this.wallets.listProvisioning();
    let repaired = 0;
    for (const wallet of stuck) {
      try {
        await this.provision(wallet);
        repaired += 1;
      } catch (err) {
        // A boot must not fail because the upstream is briefly down: the wallet stays
        // `provisioning`, every signing route refuses it, and the endpoint can retry later.
        logWarn("wallet.reconcile_failed", { walletId: wallet.id, err });
      }
    }
    return repaired;
  }

  async get(id: string): Promise<Wallet> {
    return this.require(id);
  }

  /**
   * Collateral balance of each wallet's proxy address, in the order the ids were given.
   *
   * Every id is resolved before dpm-wallet is called, so an unknown id fails the whole request
   * with a 404. A wallet with no proxy address yet (still provisioning) is not an error: it is
   * left out of the upstream call and comes back with null fields in its own position, so one
   * such row cannot blank a page of balances. With none to look up, dpm-wallet is not called.
   */
  async balances(ids: string[]): Promise<WalletBalance[]> {
    const wallets = await Promise.all(ids.map((id) => this.require(id)));
    const addresses = wallets.flatMap((wallet) =>
      wallet.proxyAddress ? [wallet.proxyAddress] : [],
    );
    const upstream = addresses.length > 0 ? await this.upstream.balances(addresses) : [];
    let next = 0;
    return wallets.map((wallet) => {
      if (!wallet.proxyAddress) {
        return { walletId: wallet.id, proxyAddress: null, balanceMicro: null, blockNumber: null };
      }
      const item = upstream[next++];
      if (!item) {
        throw new ManagerError("UPSTREAM_REJECTED", "dpm-wallet returned too few balances", {
          details: { expected: addresses.length, received: upstream.length },
        });
      }
      return {
        walletId: wallet.id,
        proxyAddress: wallet.proxyAddress,
        balanceMicro: toMicro(item.balanceRaw, item.decimals),
        blockNumber: item.blockNumber ? item.blockNumber : null,
      };
    });
  }

  async getByExternalId(externalId: string): Promise<Wallet> {
    const wallet = await this.wallets.findByExternalId(externalId);
    if (!wallet) throw walletNotFound(externalId);
    return wallet;
  }

  /**
   * The lookup every signing route uses. Refusing here rather than in each route is what stops a
   * half-provisioned or disabled wallet reaching the upstream at all.
   */
  async getReady(id: string): Promise<ReadyWallet> {
    const wallet = await this.require(id);
    if (wallet.status === "disabled") throw walletDisabled(id);
    if (!isReady(wallet)) throw walletNotReady(id);
    return wallet;
  }

  async getByKind(kind: WalletKind): Promise<Wallet | undefined> {
    return this.wallets.findByKind(kind);
  }

  list(filter: WalletFilter, limit: number, offset: number): Promise<WalletPage> {
    return this.wallets.list(filter, limit, offset);
  }

  /**
   * Hands back the EOA and a signature over the platform's fixed attestation message. The private
   * key never leaves dpm-wallet, so proof of control is the only thing that can be passed on; the
   * caller posts it to the DPM platform to register the address.
   */
  async signDpmAttestation(id: string, actor: Actor): Promise<UpstreamAttestation> {
    const wallet = await this.getReady(id);
    const attestation = await this.upstream.signDpmAttestation(wallet.ref);
    await this.audit.record({
      actor,
      walletId: id,
      action: AuditAction.WalletDpmAttestation,
      outcome: AuditOutcome.Success,
      detail: { address: attestation.address },
    });
    return attestation;
  }

  /**
   * Records that the DPM platform has registered this wallet's EOA. Upstream meta-transaction
   * signing depends on it — the RelayHub nonce is resolved from the platform's user table — so
   * this is a precondition, not a label.
   */
  async setDpmRegistered(id: string, registered: boolean, actor: Actor): Promise<Wallet> {
    const wallet = await this.getReady(id);
    const upstream = await this.upstream.setDpmRegistered(wallet.ref, registered);
    const updated = await this.wallets.setDpmRegistered(
      id,
      upstream.dpmRegistered,
      new Date().toISOString(),
    );
    await this.audit.record({
      actor,
      walletId: id,
      action: AuditAction.WalletDpmRegistered,
      outcome: AuditOutcome.Success,
      detail: { registered: upstream.dpmRegistered },
    });
    return updated ?? wallet;
  }

  async update(
    id: string,
    changes: { label?: string; status?: "active" | "disabled" },
    actor: Actor,
  ): Promise<Wallet> {
    const wallet = await this.require(id);
    if (wallet.status === "provisioning" && changes.status) throw walletNotReady(id);

    const updated = await this.wallets.update(id, changes, new Date().toISOString());
    await this.audit.record({
      actor,
      walletId: id,
      action: AuditAction.WalletUpdate,
      outcome: AuditOutcome.Success,
      detail: { ...changes },
    });
    return updated ?? wallet;
  }

  count(): Promise<number> {
    return this.wallets.count();
  }

  /**
   * An active platform wallet the DPM platform has never registered — one created before the
   * operations wallet was registered automatically — is registered now, so calling the create
   * endpoint again is the repair. Anything else is returned as it is.
   */
  private async registerIfPlatform(wallet: Wallet): Promise<Wallet> {
    if (!PLATFORM_KINDS.has(wallet.kind) || wallet.dpmRegistered || !isReady(wallet)) return wallet;
    const registered = await this.registerWithDpm(wallet);
    const updated = await this.wallets.setDpmRegistered(
      wallet.id,
      registered.dpmRegistered,
      new Date().toISOString(),
    );
    return updated ?? wallet;
  }

  /**
   * Registers a wallet's EOA with the DPM platform, through dpm-wallet — which holds both the
   * signing key and the builder credential the platform authenticates the call with, so the
   * whole exchange happens in one hop from here.
   */
  private async registerWithDpm(wallet: Wallet): Promise<UpstreamAddress> {
    const registered = await this.upstream.dpmRegister(wallet.ref);
    await this.audit.record({
      walletId: wallet.id,
      action: AuditAction.WalletDpmRegister,
      outcome: AuditOutcome.Success,
      detail: { kind: wallet.kind, address: registered.address },
    });
    return registered;
  }

  /**
   * Step 2 and 3 of creation, and the whole of reconcile.
   *
   * The idempotency key is the row id, which makes the upstream call safe to repeat: dpm-wallet
   * replays its stored response rather than deriving a second account. `REF_ALREADY_EXISTS` is
   * the case where our first attempt did land — read the address it minted rather than failing.
   */
  private async provision(wallet: Wallet): Promise<ReadyWallet> {
    let address: UpstreamAddress;
    try {
      address = await this.upstream.createAddress(wallet.ref, { idempotencyKey: wallet.id });
    } catch (err) {
      if (err instanceof UpstreamError && err.upstreamCode === UPSTREAM_REF_ALREADY_EXISTS) {
        address = await this.upstream.getAddress(wallet.ref);
      } else {
        throw err;
      }
    }

    // Before the wallet is marked ready, not after: a platform wallet the DPM platform has never
    // seen cannot sign a single transfer (relayer-api has no nonce for it), and an active row
    // that fails at its first transfer is worse than one still visibly half-built. A failure
    // here throws, leaving the row `provisioning` for `reconcile` and the boot sweep to finish.
    if (PLATFORM_KINDS.has(wallet.kind) && !address.dpmRegistered) {
      address = await this.registerWithDpm(wallet);
    }

    const provisioned = await this.wallets.markProvisioned(
      wallet.id,
      {
        eoaAddress: address.address,
        proxyAddress: address.proxyAddress,
        derivationIndex: address.index,
        dpmRegistered: address.dpmRegistered,
      },
      new Date().toISOString(),
    );
    if (!provisioned || !isReady(provisioned)) {
      throw new ManagerError("INTERNAL_ERROR", `Wallet ${wallet.id} did not become ready`);
    }
    return provisioned;
  }

  private async insert(wallet: Parameters<WalletRepository["insertProvisioning"]>[0]) {
    try {
      return await this.wallets.insertProvisioning(wallet);
    } catch (err) {
      throw this.toConflict(err, wallet.kind, wallet.externalId);
    }
  }

  /**
   * The three unique indexes on `wallets` are what enforce "one master", "one operations" and
   * "one wallet per external id" under concurrency. Translating the violation here is what turns
   * a database error into an answer the caller can act on.
   */
  private toConflict(err: unknown, kind: WalletKind, externalId: string | null): unknown {
    const violation = uniqueViolation(err);
    if (!violation) return err;
    const constraint = violation.constraint;
    if (constraint === "wallets_one_master") {
      return new ManagerError("MASTER_WALLET_EXISTS", "A master wallet already exists");
    }
    if (constraint === "wallets_one_operations") {
      return new ManagerError("OPERATIONS_WALLET_EXISTS", "An operations wallet already exists");
    }
    if (constraint === "wallets_external_lower") {
      return new ManagerError(
        "EXTERNAL_ID_TAKEN",
        `A wallet already exists for external id "${externalId ?? ""}"`,
        { details: { externalId } },
      );
    }
    logWarn("wallet.unexpected_conflict", { constraint, kind });
    return err;
  }

  private async require(id: string): Promise<Wallet> {
    const wallet = await this.wallets.findById(id);
    if (!wallet) throw walletNotFound(id);
    return wallet;
  }
}

export type WalletBalance = {
  walletId: string;
  proxyAddress: string | null;
  balanceMicro: string | null;
  blockNumber: number | null;
};

/** Rescales a raw token amount to 6 decimals in bigint, truncating any finer digits. */
function toMicro(raw: string, decimals: number): string {
  const value = BigInt(raw);
  if (decimals === 6) return value.toString();
  return decimals > 6
    ? (value / 10n ** BigInt(decimals - 6)).toString()
    : (value * 10n ** BigInt(6 - decimals)).toString();
}

function kindAction(kind: WalletKind): AuditAction {
  if (kind === "master") return AuditAction.PlatformMasterWalletCreate;
  if (kind === "operations") return AuditAction.PlatformOperationsWalletCreate;
  return AuditAction.WalletCreate;
}

/**
 * TypeORM wraps the driver error and copies its fields onto the wrapper, but not on every version
 * and not for every driver — so both are checked rather than relying on one.
 */
function uniqueViolation(err: unknown): { constraint: string } | undefined {
  for (const candidate of [err, (err as { driverError?: unknown } | null)?.driverError]) {
    if (typeof candidate !== "object" || candidate === null) continue;
    const { code, constraint } = candidate as { code?: unknown; constraint?: unknown };
    if (code === UNIQUE_VIOLATION) {
      return { constraint: typeof constraint === "string" ? constraint : "" };
    }
  }
  return undefined;
}
