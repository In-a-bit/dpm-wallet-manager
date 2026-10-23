import { Module } from "@nestjs/common";

import { RetentionModule } from "../retention/retention.module";
import { SettingsController } from "./settings.controller";
import { StorageSettingsService } from "./storage-settings.service";

@Module({
  imports: [RetentionModule],
  controllers: [SettingsController],
  providers: [StorageSettingsService],
  exports: [StorageSettingsService],
})
export class SettingsModule {}
