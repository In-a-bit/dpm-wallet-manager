import { Global, Module } from "@nestjs/common";

import { SessionController } from "../session/session.controller";
import { SessionService } from "../session/session.service";
import { UiUsersController } from "./ui-users.controller";
import { UiUsersService } from "./ui-users.service";

/**
 * Admin UI accounts and their sessions. Global because the app-scoped `ApiKeyGuard` injects the
 * session service, the same reason `ApiKeysModule` is global.
 */
@Global()
@Module({
  controllers: [SessionController, UiUsersController],
  providers: [SessionService, UiUsersService],
  exports: [SessionService, UiUsersService],
})
export class UiUsersModule {}
