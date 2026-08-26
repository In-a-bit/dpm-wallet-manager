import { Inject, Injectable, type OnApplicationBootstrap } from "@nestjs/common";

import type { Db } from "../db/client";
import { IdempotencyRepository } from "../db/repositories/idempotency.repo";
import { logInfo } from "../observability/log";
import { PlatformService } from "../platform/platform.service";
import { WalletsService } from "../wallets/wallets.service";
import { DB } from "../tokens";
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
    private readonly idempotency: IdempotencyRepository,
    private readonly wallets: WalletsService,
    private readonly platform: PlatformService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await assertSchemaPresent(this.db);
    // Before anything else that could act on it: a mismatch between the configured mode and the
    // burned one throws here, which kills the process rather than serving orders routed the wrong
    // way for whichever mode happens to win.
    const mode = await this.platform.burnMode();
    await this.platform.recordModeBurnIfNew();

    const purged = await this.idempotency.purgeExpired();
    // A container that died between writing a wallet row and hearing back from dpm-wallet leaves
    // the row `provisioning`. Finishing those here means the wallet is usable by the time traffic
    // arrives, rather than on whenever someone happens to call reconcile.
    const reconciled = await this.wallets.reconcileAll();
    logInfo("startup.ready", {
      mode,
      purgedIdempotencyKeys: purged,
      reconciledWallets: reconciled,
    });
  }
}
