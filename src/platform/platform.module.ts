import { Global, Module } from "@nestjs/common";

import { PlatformController } from "./platform.controller";
import { PlatformService } from "./platform.service";

/** Global: the order and meta-transaction modules both ask it for the mode. */
@Global()
@Module({
  controllers: [PlatformController],
  providers: [PlatformService],
  exports: [PlatformService],
})
export class PlatformModule {}
