import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from "@nestjs/core";

import { ApiKeysModule } from "./api-keys/api-keys.module";
import { AuditModule } from "./audit/audit.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { ApiKeyGuard } from "./common/guards/api-key.guard";
import { IdempotencyInterceptor } from "./common/interceptors/idempotency.interceptor";
import { RolesGuard } from "./common/guards/roles.guard";
import { createValidationPipe } from "./common/validation/validation-pipe";
import { AppConfigModule } from "./config.module";
import { DatabaseModule } from "./database.module";
import { HealthModule } from "./health/health.module";
import { MetaTxModule } from "./meta-tx/meta-tx.module";
import { ObservabilityModule } from "./observability/observability.module";
import { OrdersModule } from "./orders/orders.module";
import { PlatformModule } from "./platform/platform.module";
import { PolicyModule } from "./policy/policy.module";
import { StartupService } from "./startup/startup.service";
import { WalletsModule } from "./wallets/wallets.module";

/**
 * The composition root. The app-scoped providers are what an Express middleware chain would
 * express positionally: every body is validated the same way, and every exception becomes one
 * envelope, every request is authenticated unless it says `@Public()`, and every response is
 * idempotency-aware.
 */
@Module({
  imports: [
    AppConfigModule,
    DatabaseModule,
    ObservabilityModule,
    ApiKeysModule,
    WalletsModule,
    PlatformModule,
    PolicyModule,
    OrdersModule,
    MetaTxModule,
    AuditModule,
    HealthModule,
  ],
  providers: [
    StartupService,
    // Order matters and is positional: ApiKeyGuard puts the actor on the request, RolesGuard
    // reads it. Nest runs app-scoped guards in declaration order.
    { provide: APP_GUARD, useClass: ApiKeyGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
