import { Global, Module } from "@nestjs/common";

import { AuditLog } from "./audit";

/** Global: every feature writes to the audit trail, and none of them owns it. */
@Global()
@Module({ providers: [AuditLog], exports: [AuditLog] })
export class ObservabilityModule {}
