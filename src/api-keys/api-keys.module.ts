import { Global, Module } from "@nestjs/common";

import { ApiKeyAuthenticator } from "./api-key-authenticator";
import { ApiKeyService } from "./api-key.service";
import { ApiKeysController } from "./api-keys.controller";

/**
 * Global because the app-scoped `ApiKeyGuard` injects the authenticator, and an app-scoped
 * provider is constructed outside any feature module's scope.
 */
@Global()
@Module({
  controllers: [ApiKeysController],
  providers: [ApiKeyService, ApiKeyAuthenticator],
  exports: [ApiKeyService, ApiKeyAuthenticator],
})
export class ApiKeysModule {}
