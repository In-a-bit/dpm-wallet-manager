import { Module } from "@nestjs/common";

import { MetaTxController } from "./meta-tx.controller";
import { MetaTxService } from "./meta-tx.service";
import { TransfersController } from "./transfers.controller";
import { TransfersService } from "./transfers.service";

@Module({
  controllers: [MetaTxController, TransfersController],
  providers: [MetaTxService, TransfersService],
})
export class MetaTxModule {}
