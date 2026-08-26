import { Inject, Injectable } from "@nestjs/common";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { Actor } from "../common/actor";
import { PLATFORM_MODES, type Config, type PlatformMode } from "../config";
import type { WalletKind } from "../db/entities";
import { PlatformSettingsRepository } from "../db/repositories/platform-settings.repo";
import type { Wallet } from "../db/repositories/wallet.repo";
import { ManagerError, internalError } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { logInfo, logWarn } from "../observability/log";
import { CONFIG } from "../tokens";
import { WalletsService } from "../wallets/wallets.service";

export const MODE_SETTING_KEY = "mode";

export type PlatformStatus = {
  mode: PlatformMode;
  modeBurnedAt: string | null;
  masterWallet: Wallet | undefined;
  operationsWallet: Wallet | undefined;
  walletCount: number;
  upstream: { reachable: boolean; vault?: { initialized: boolean; ready: boolean } };
};

/**
 * Owns the custody mode and the two platform wallets.
 *
 * The mode is the single most consequential value in this service: it decides, for every order
 * signed from here on, whose funds are spent and who receives the proceeds. It is therefore
 * write-once, and this class is the only thing that writes it.
 */
@Injectable()
export class PlatformService {
  /**
   * Cached after the burn. Safe precisely because the value cannot change — the immutability is
   * what makes the order router able to ask for the mode without a query per request.
   */
  private burnedMode: PlatformMode | undefined;

  constructor(
    private readonly settings: PlatformSettingsRepository,
    private readonly wallets: WalletsService,
    private readonly upstream: DpmWalletClient,
    private readonly audit: AuditLog,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Reconciles the configured mode with the burned one, at boot, before anything serves.
   *
   * Three outcomes, and the third is the point: if the database already holds a mode and the
   * environment says something else, the container refuses to start. Honouring either one
   * silently would be worse — picking the environment would reroute every new order away from the
   * wallets the existing ones settled against, and picking the database would leave an operator
   * convinced they had switched modes when they had not. There is no correct automatic answer, so
   * the process exits and says so.
   */
  async burnMode(): Promise<PlatformMode> {
    const configured = this.config.mode;
    const stored = await this.settings.burnOnce(
      MODE_SETTING_KEY,
      configured,
      new Date().toISOString(),
    );

    if (!isMode(stored)) {
      throw new Error(
        `platform_settings holds mode="${stored}", which is not one of ${PLATFORM_MODES.join(", ")}`,
      );
    }
    if (stored !== configured) {
      throw new Error(
        `PLATFORM_MODE_MISMATCH: this database was initialised in "${stored}" mode but ` +
          `DPM_WALLET_MANAGER_MODE is "${configured}". The mode is burned in on first boot and ` +
          "cannot be changed; either correct the environment or point at the right database.",
      );
    }

    this.burnedMode = stored;
    const burnedAt = await this.settings.writtenAt(MODE_SETTING_KEY);
    logInfo("platform.mode", { mode: stored, burnedAt });
    return stored;
  }

  /** Records the burn once, on the boot that actually performed it. */
  async recordModeBurnIfNew(): Promise<void> {
    const burnedAt = await this.settings.writtenAt(MODE_SETTING_KEY);
    if (!burnedAt) return;
    const recent = Date.now() - Date.parse(burnedAt) < 5_000;
    if (!recent) return;
    await this.audit.record({
      action: AuditAction.PlatformModeBurned,
      outcome: AuditOutcome.Success,
      detail: { mode: this.mode, burnedAt },
    });
  }

  /** The mode, after the boot-time burn. Reading it earlier is a wiring bug. */
  get mode(): PlatformMode {
    if (!this.burnedMode) throw internalError("Platform mode was read before it was burned in");
    return this.burnedMode;
  }

  get isShared(): boolean {
    return this.mode === "shared";
  }

  /**
   * The master wallet: the only wallet USDC may leave the platform from, and the only one that
   * never gets an allowance. Admin-only, because creating it is establishing where the exit door
   * is.
   */
  createMasterWallet(actor: Actor, label?: string): Promise<Wallet> {
    return this.createPlatformWallet("master", actor, label ?? "Master wallet");
  }

  /**
   * The operations wallet: in shared mode the treasury that makes every BUY and receives every
   * SELL. Operator-reachable, because provisioning it is part of standing the platform up rather
   * than an act of administration — and an admin key works here too.
   */
  createOperationsWallet(actor: Actor, label?: string): Promise<Wallet> {
    return this.createPlatformWallet("operations", actor, label ?? "Operations wallet");
  }

  async masterWallet(): Promise<Wallet | undefined> {
    return this.wallets.getByKind("master");
  }

  async operationsWallet(): Promise<Wallet | undefined> {
    return this.wallets.getByKind("operations");
  }

  /**
   * The operations wallet, required. Shared-mode order routing cannot proceed without it: there
   * would be no funding wallet to make a BUY, and a SELL would have nowhere to send the proceeds.
   */
  async requireOperationsWallet(): Promise<Wallet> {
    const wallet = await this.operationsWallet();
    if (!wallet) {
      throw new ManagerError(
        "OPERATIONS_WALLET_REQUIRED",
        'This install runs in "shared" mode, which needs an operations wallet. ' +
          "Create one with POST /v1/platform/operations-wallet.",
      );
    }
    return wallet;
  }

  async status(): Promise<PlatformStatus> {
    const [masterWallet, operationsWallet, walletCount, upstream] = await Promise.all([
      this.masterWallet(),
      this.operationsWallet(),
      this.wallets.count(),
      this.upstreamStatus(),
    ]);
    return {
      mode: this.mode,
      modeBurnedAt: (await this.settings.writtenAt(MODE_SETTING_KEY)) ?? null,
      masterWallet,
      operationsWallet,
      walletCount,
      upstream,
    };
  }

  /**
   * Idempotent by design: the singleton is returned rather than refused. A provisioning script
   * that runs twice — or a UI button pressed twice — should not need to know whether it is the
   * first, and the two partial unique indexes make the race safe underneath.
   */
  private async createPlatformWallet(
    kind: Exclude<WalletKind, "user">,
    actor: Actor,
    label: string,
  ): Promise<Wallet> {
    const existing = await this.wallets.getByKind(kind);
    if (existing) return this.wallets.reconcile(existing.id, actor);

    try {
      return await this.wallets.create({ kind, label }, actor);
    } catch (err) {
      // Lost the race against another caller: the winner's wallet is the right answer.
      if (err instanceof ManagerError && isExistsCode(err.code)) {
        const winner = await this.wallets.getByKind(kind);
        if (winner) return winner;
      }
      throw err;
    }
  }

  private async upstreamStatus(): Promise<PlatformStatus["upstream"]> {
    try {
      const health = await this.upstream.health();
      return {
        reachable: health.status === "ok",
        ...(health.vault
          ? { vault: { initialized: health.vault.initialized, ready: health.vault.ready } }
          : {}),
      };
    } catch (err) {
      // A status endpoint that 502s because the thing it reports on is down is useless: the whole
      // reason to call it is to find out that dpm-wallet is unreachable.
      logWarn("platform.upstream_unreachable", { err });
      return { reachable: false };
    }
  }
}

function isMode(value: string): value is PlatformMode {
  return (PLATFORM_MODES as readonly string[]).includes(value);
}

function isExistsCode(code: string): boolean {
  return code === "MASTER_WALLET_EXISTS" || code === "OPERATIONS_WALLET_EXISTS";
}
