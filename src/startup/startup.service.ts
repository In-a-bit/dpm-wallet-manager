import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import { ApiKeyService } from "../api-keys/api-key.service";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo";
import { logInfo, logWarn } from "../observability/log";
import { PlatformService } from "../platform/platform.service";
import { SessionService } from "../session/session.service";
import { WalletsService } from "../wallets/wallets.service";
import { CONFIG, DB } from "../tokens";
import { assertSchemaPresent } from "./schema-check";

/**
 * Everything that has to be true before the server binds, in the order it has to be true in.
 *
 * Nest runs this after every provider is constructed and before `listen()` resolves, so a failure
 * here propagates out of `bootstrap()` and kills the process — which is the intent. A container
 * that cannot verify its own preconditions must not accept traffic.
 */
@Injectable()
export class StartupService implements OnApplicationBootstrap {
  constructor(
    @Inject(DB) private readonly db: Db,
    @Inject(CONFIG) private readonly config: Config,
    private readonly idempotency: IdempotencyRepository,
    private readonly wallets: WalletsService,
    private readonly platform: PlatformService,
    private readonly apiKeys: ApiKeyService,
    private readonly uiSessions: SessionService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertSchemaPresent(this.db);
    // Before anything else that could act on it: a mismatch between the configured mode and the
    // burned one throws here, which kills the process rather than serving orders routed the wrong
    // way for whichever mode happens to win.
    const mode = await this.platform.burnMode();
    await this.platform.recordModeBurnIfNew();

    await this.ensureBootstrapAdminKey();

    const purged = await this.idempotency.purgeExpired();
    const purgedSessions = await this.uiSessions.purgeExpired();
    // A container that died between writing a wallet row and hearing back from dpm-wallet leaves
    // the row `provisioning`. Finishing those here means the wallet is usable by the time traffic
    // arrives, rather than on whenever someone happens to call reconcile.
    const reconciled = await this.wallets.reconcileAll();
    logInfo("startup.ready", {
      mode,
      purgedIdempotencyKeys: purged,
      purgedUiSessions: purgedSessions,
      reconciledWallets: reconciled,
    });
  }

  /**
   * When `api_keys` is empty, mint the first admin key here — no separate CLI step.
   *
   * If `DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY` is set, that string is adopted. Otherwise a
   * random well-formed key is minted and logged once (plaintext) so a local/docker boot is
   * usable immediately. Never re-runs once any key exists.
   */
  private async ensureBootstrapAdminKey(): Promise<void> {
    if (this.config.skipStartupKeyBootstrap) return;
    if ((await this.apiKeys.list()).length > 0) return;

    const { key, created } = await this.apiKeys.bootstrap("bootstrap");
    if (!created) return;

    if (this.config.bootstrapAdminKey) {
      logInfo("startup.bootstrap_admin_key_adopted", { prefix: key.prefix, keyId: key.id });
      return;
    }
    // Generated at boot: the secret has to appear somewhere the operator can read it. Prefer
    // setting BOOTSTRAP_ADMIN_KEY in production so this line never carries a live credential.
    logWarn("startup.bootstrap_admin_key_minted", {
      keyId: key.id,
      prefix: key.prefix,
      key: key.key,
      hint: "Save this key; it is only logged once. Prefer DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY.",
    });
  }
}
