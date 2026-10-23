import { Controller, Get, Inject, Req, Res } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import { Public } from "../common/decorators/public.decorator";
import type { Db } from "../db/client";
import { DB } from "../tokens";
import { StorageSampleRepository } from "../db/repositories/storage-sample.repo";
import { HealthResponseDto, ReadyResponseDto } from "./dto/health.dto";

/** A probe must answer inside the healthcheck timeout even when the database hangs. */
const READY_TIMEOUT_MS = 3000;
/** The storage field is a courtesy: it never holds the probe up. */
const STORAGE_READ_TIMEOUT_MS = 1000;

/**
 * Loopback peers only see the storage field: `dpm-custody status` asks from inside the container
 * on 127.0.0.1, while the probe is public and the disk level is nobody else's business. The
 * socket's own address is used, never a forwarded header.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(req: Request): boolean {
  const addr = req.socket?.remoteAddress;
  return addr !== undefined && LOOPBACK.has(addr);
}

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
  constructor(
    @Inject(DB) private readonly db: Db,
    private readonly samples: StorageSampleRepository,
  ) {}

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
   * `{status}` rather than the error envelope, since a probe reads only the status code. The
   * `storage` field is added only for a loopback caller.
   */
  @Public()
  @Get("ready")
  @ApiOperation({
    operationId: "getHealthReady",
    summary: "Readiness probe",
    description:
      "Runs a trivial database query. Answers 200 with status ok, or 503 with status unavailable (a bare status body, not the error envelope) when the database does not answer.",
  })
  @ApiOkResponse({ type: ReadyResponseDto })
  async ready(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<ReadyResponseDto> {
    try {
      await withTimeout(this.db.query("SELECT 1"), READY_TIMEOUT_MS);
    } catch {
      res.status(503);
      return { status: "unavailable" };
    }
    if (!isLoopback(req)) return { status: "ok" };
    return { status: "ok", ...(await this.storage()) };
  }

  /** The latest sample's level, for `dpm-custody status`. A failed or slow read just omits it. */
  private async storage(): Promise<{ storage?: ReadyResponseDto["storage"] }> {
    try {
      const sample = await withTimeout(this.samples.latest(), STORAGE_READ_TIMEOUT_MS);
      if (!sample) return {};
      return {
        storage: {
          level: sample.level,
          usedPercent:
            sample.diskUsedPercent === null ? null : Math.round(sample.diskUsedPercent * 10) / 10,
          daysToFull: sample.daysToFull === null ? null : Math.round(sample.daysToFull),
        },
      };
    } catch {
      return {};
    }
  }
}
