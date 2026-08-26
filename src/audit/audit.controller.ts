import { Controller, Get, Query } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { OperationRepository } from "../db/repositories/operation.repo";
import { AuditLog } from "../observability/audit";
import { AuditQueryDto, OperationQueryDto } from "./dto/audit-query.dto";
import { AuditPageDto, OperationPageDto } from "./dto/audit-response.dto";

/**
 * Two views of the past, deliberately separate.
 *
 * Both are readable by either role: an operator who cannot see what their own key did has no way
 * to reconcile their books.
 */
@ApiTags("audit")
@ApiAuth()
@Controller()
export class AuditController {
  constructor(
    private readonly audit: AuditLog,
    private readonly operations: OperationRepository,
  ) {}

  /**
   * The decision log.
   *
   * Who asked for what, and whether it was permitted — denials included. `meta.withdraw.external`
   * is the one action that means money left the platform, and has its own name so it can be
   * alerted on without matching every other withdrawal.
   *
   * Newest first. Details are redacted before they are stored, so no row holds a credential.
   */
  @Get("audit")
  @ApiOperation({ operationId: "queryAudit", summary: "Query the decision log" })
  @ApiOkResponse({ type: AuditPageDto })
  @ApiErrors("VALIDATION_FAILED")
  async query(@Query() query: AuditQueryDto): Promise<AuditPageDto> {
    const page = await this.audit.query(
      {
        action: query.action,
        outcome: query.outcome,
        walletId: query.walletId,
        actorKeyId: query.actorKeyId,
        from: query.from,
        to: query.to,
      },
      query.limit,
      query.offset,
    );
    return { items: page.events, total: page.total, limit: query.limit, offset: query.offset };
  }

  /**
   * The artefact log.
   *
   * What was actually signed, on whose behalf, and **by which wallet**. That last part is why this
   * is separate from the decision log: in shared mode a BUY is signed by the operations wallet, so
   * "which wallet signed the order behind this hash" is not answerable from the decision log alone.
   *
   * Holds no signatures, only a summary — an order hash, or a `from:nonce` pair.
   */
  @Get("operations")
  @ApiOperation({ operationId: "queryOperations", summary: "Query the artefact log" })
  @ApiOkResponse({ type: OperationPageDto })
  @ApiErrors("VALIDATION_FAILED")
  async operationsQuery(@Query() query: OperationQueryDto): Promise<OperationPageDto> {
    const page = await this.operations.query(
      { walletId: query.walletId, kind: query.kind, from: query.from, to: query.to },
      query.limit,
      query.offset,
    );
    return { items: page.operations, total: page.total, limit: query.limit, offset: query.offset };
  }
}
