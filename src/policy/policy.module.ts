import { Global, Module } from "@nestjs/common";

import { FundsPolicyService } from "./funds-policy.service";

/** Global: orders and meta-transactions both gate on it, and there is only one policy. */
@Global()
@Module({ providers: [FundsPolicyService], exports: [FundsPolicyService] })
export class PolicyModule {}
