import { Module } from "@nestjs/common";

import { RetentionModule } from "../retention/retention.module";
import { SettingsModule } from "../settings/settings.module";
import { StorageController } from "./storage.controller";
import { StorageMonitorService } from "./storage-monitor.service";

@Module({
  imports: [RetentionModule, SettingsModule],
  controllers: [StorageController],
  providers: [StorageMonitorService],
  exports: [StorageMonitorService],
})
export class StorageModule {}
