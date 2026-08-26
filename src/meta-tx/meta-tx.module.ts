import { Module } from "@nestjs/common";

import { MetaTxController } from "./meta-tx.controller";
import { MetaTxService } from "./meta-tx.service";

@Module({ controllers: [MetaTxController], providers: [MetaTxService] })
export class MetaTxModule {}
