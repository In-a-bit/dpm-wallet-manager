import { Controller, Get } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Public } from "../common/decorators/public.decorator";
import { HealthResponseDto } from "./dto/health.dto";

/**
 * The one public route, matching the dpm-wallet convention: an orchestrator's probe should not
 * need a credential. It carries no `@ApiAuth()` for the same reason — a probe reading the schema
 * should not be told to authenticate.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  /**
   * Liveness.
   *
   * Answers only "is this process up". It does not touch the database or dpm-wallet, so it stays
   * true while either is degraded — `GET /v1/platform` is what reports those.
   */
  @Public()
  @Get()
  @ApiOperation({ operationId: "getHealth", summary: "Liveness probe" })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): HealthResponseDto {
    return { status: "ok" };
  }
}
