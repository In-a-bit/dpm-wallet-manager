import { Controller, Get, Inject, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Response } from "express";

import { Public } from "../common/decorators/public.decorator";
import type { Db } from "../db/client";
import { DB } from "../tokens";
import { HealthResponseDto } from "./dto/health.dto";

/** A probe must answer inside the healthcheck timeout even when the database hangs. */
const READY_TIMEOUT_MS = 3000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("readiness query timed out")), ms);
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/**
 * The one public route, matching the dpm-wallet convention: an orchestrator's probe should not
 * need a credential. It carries no `@ApiAuth()` for the same reason — a probe reading the schema
 * should not be told to authenticate.
 */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Liveness.
   *
   * Answers only "is this process up". It does not touch the database or dpm-wallet, so it stays
   * true while either is degraded — `GET /v1/platform` is what reports those. Use
   * `GET /v1/health/ready` to ask whether the database answers.
   */
  @Public()
  @Get()
  @ApiOperation({ operationId: "getHealth", summary: "Liveness probe" })
  @ApiOkResponse({ type: HealthResponseDto })
  check(): HealthResponseDto {
    return { status: "ok" };
  }

  /**
   * Readiness: the database answers `SELECT 1`. The compose healthcheck uses this. The 503 body is
   * `{status}` rather than the error envelope, since a probe reads only the status code.
   */
  @Public()
  @Get("ready")
  @ApiOperation({
    operationId: "getHealthReady",
    summary: "Readiness probe",
    description:
      "Runs a trivial database query. Answers 200 with status ok, or 503 with status unavailable (a bare status body, not the error envelope) when the database does not answer.",
  })
  @ApiOkResponse({ type: HealthResponseDto })
  async ready(@Res({ passthrough: true }) res: Response): Promise<HealthResponseDto> {
    try {
      await withTimeout(this.db.query("SELECT 1"), READY_TIMEOUT_MS);
      return { status: "ok" };
    } catch {
      res.status(503);
      return { status: "unavailable" };
    }
  }
}
