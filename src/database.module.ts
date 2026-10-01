import { Global, Inject, Module, type OnApplicationShutdown } from "@nestjs/common";

import type { Config } from "./config";
import { closeDatabase, openDatabase, type Db } from "./db/client";
import { ApiKeyRepository } from "./db/repositories/api-key.repo";
import { AuditRepository } from "./db/repositories/audit.repo";
import { IdempotencyRepository } from "./db/repositories/idempotency.repo";
import { OperationRepository } from "./db/repositories/operation.repo";
import { PlatformSettingsRepository } from "./db/repositories/platform-settings.repo";
import { UiSessionRepository } from "./db/repositories/ui-session.repo";
import { UiUserRepository } from "./db/repositories/ui-user.repo";
import { WalletRepository } from "./db/repositories/wallet.repo";
import { CONFIG, DB, TRANSACTION, type Transaction } from "./tokens";

const REPOSITORIES = [
  ApiKeyRepository,
  AuditRepository,
  IdempotencyRepository,
  OperationRepository,
  PlatformSettingsRepository,
  UiSessionRepository,
  UiUserRepository,
  WalletRepository,
];

/**
 * Opens the connection pool before anything that reads it is constructed. Global because the
 * repositories it exports are needed across every feature.
 */
@Global()
@Module({
  providers: [
    {
      // No explicit `await` here, but Nest's injector awaits whatever a `useFactory` returns
      // before treating the provider as resolved — so nothing that injects a repository is
      // constructed before the data source has connected and built its entity metadata.
      provide: DB,
      useFactory: (config: Config) => openDatabase(config.databaseUrl),
      inject: [CONFIG],
    },
    {
      provide: TRANSACTION,
      useFactory:
        (db: Db): Transaction =>
        (work) =>
          db.transaction(work),
      inject: [DB],
    },
    ...REPOSITORIES,
  ],
  exports: [DB, TRANSACTION, ...REPOSITORIES],
})
export class DatabaseModule implements OnApplicationShutdown {
  constructor(@Inject(DB) private readonly db: Db) {}

  /** Drains the pool, so a shutdown does not leave connections open on the server. */
  async onApplicationShutdown(): Promise<void> {
    await closeDatabase(this.db);
  }
}
