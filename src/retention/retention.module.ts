import { Module } from "@nestjs/common";

import { WalletsModule } from "../wallets/wallets.module";
import { RetentionSettingsService } from "../settings/retention-settings.service";
import { RetentionService } from "./retention.service";

@Module({
  imports: [WalletsModule],
  providers: [RetentionSettingsService, RetentionService],
  exports: [RetentionSettingsService, RetentionService],
})
export class RetentionModule {}
