import { Global, Module } from "@nestjs/common";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import { WalletsController } from "./wallets.controller";
import { WalletsService } from "./wallets.service";

/**
 * Global because the platform, order and meta-transaction modules all resolve wallets, and the
 * upstream client has exactly one sensible instance.
 */
@Global()
@Module({
  controllers: [WalletsController],
  providers: [WalletsService, DpmWalletClient],
  exports: [WalletsService, DpmWalletClient],
})
export class WalletsModule {}
