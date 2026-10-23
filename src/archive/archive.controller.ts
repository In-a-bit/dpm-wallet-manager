import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Res,
} from "@nestjs/common";
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { Response } from "express";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { PaginationDto } from "../common/dto/pagination.dto";
import { IsUuidPipe } from "../common/pipes/uuid.pipe";
import { archiveCode } from "./archive-writer";
import { ArchiveService } from "./archive.service";
import {
  ArchiveCreatedDto,
  ArchiveDeleteAcceptedDto,
  ArchivePageDto,
  ArchivePreviewDto,
  ArchivePreviewQueryDto,
  CreateArchiveDto,
  DeleteArchiveDto,
} from "./dto/archive.dto";

const ARCHIVE_ID = {
  name: "id",
  format: "uuid",
  description: "The archive's id, as returned by POST /v1/archives.",
} as const;

/**
 * Important records out to a verified file, then out of the database on confirmation. Any key may
 * list and preview; creating, downloading and deleting are admin only.
 */
@ApiTags("archives")
@ApiAuth()
@Controller("archives")
export class ArchiveController {
  constructor(private readonly archives: ArchiveService) {}

  /**
   * List every archive, newest first.
   *
   * When, by whom, the cutoff, the scope, the SHA-256 and size of the downloaded file, the status
   * and the rows deleted. Archives are never trimmed.
   */
  @Get()
  @ApiOperation({ operationId: "listArchives", summary: "List archives" })
  @ApiOkResponse({ type: ArchivePageDto })
  @ApiErrors("VALIDATION_FAILED")
  async list(@Query() query: PaginationDto): Promise<ArchivePageDto> {
    const page = await this.archives.list(query.limit, query.offset);
    return {
      items: page.items.map((archive) => ({ ...archive, code: archiveCode(archive.id) })),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Count what an archive would cover.
   *
   * Rows per table that are important (withdrawals, and audit events retention never trims, other
   * than the `archive.*` trail) and older than `before`, counted now. `before` must be at least a
   * day ago.
   */
  @Get("preview")
  @ApiOperation({ operationId: "previewArchive", summary: "Count the rows an archive would cover" })
  @ApiOkResponse({ type: ArchivePreviewDto })
  @ApiErrors("VALIDATION_FAILED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED")
  preview(@Query() query: ArchivePreviewQueryDto): Promise<ArchivePreviewDto> {
    return this.archives.preview(query.before);
  }

  /**
   * Create an archive.
   *
   * Fixes the scope now: per table, the highest id among the important rows older than `before`,
   * so rows written later are never in it. The archive starts `pending`; download it next. Only
   * one archive may be pending, downloaded or deleting at a time.
   */
  @Post()
  @Roles("admin")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: "createArchive", summary: "Create an archive" })
  @ApiCreatedResponse({ type: ArchiveCreatedDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "CSRF_HEADER_REQUIRED",
    "ARCHIVE_IN_PROGRESS",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
  )
  create(@Body() body: CreateArchiveDto, @CurrentActor() actor: Actor): Promise<ArchiveCreatedDto> {
    return this.archives.create(body.before, actor);
  }

  /**
   * Download an archive as gzipped ndjson.
   *
   * The file is `dpm-archive-<install>-<yyyymmdd>-<code>.ndjson.gz`: a manifest line, then one
   * `{table, row}` line per row in scope. The archive becomes `downloaded`, with the SHA-256 of
   * the bytes sent, only once the whole file was sent; a download that breaks off leaves it
   * `pending`, and it can be downloaded again.
   */
  @Get(":id/download")
  @Roles("admin")
  @ApiOperation({ operationId: "downloadArchive", summary: "Download an archive file" })
  @ApiParam(ARCHIVE_ID)
  @ApiOkResponse({
    description: "Gzipped ndjson: a manifest line, then `{table, row}` lines.",
    content: { "application/gzip": { schema: { type: "string", format: "binary" } } },
  })
  @ApiErrors("VALIDATION_FAILED", "ARCHIVE_NOT_FOUND", "ARCHIVE_NOT_READY")
  async download(
    @Param("id", IsUuidPipe) id: string,
    @CurrentActor() actor: Actor,
    @Res() res: Response,
  ): Promise<void> {
    await this.archives.download(id, actor, res);
  }

  /**
   * Delete an archive's rows.
   *
   * Needs a complete download and the 6-character code from the file name. Deletes exactly the
   * rows in the archive's scope, in batches in the background, then reclaims the space for reuse
   * (`VACUUM`; the disk itself does not shrink). Poll the list until the status is `done`. An
   * archive left `deleting` by a failure resumes with the same call.
   */
  @Post(":id/delete")
  @Roles("admin")
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ operationId: "deleteArchive", summary: "Delete an archive's rows" })
  @ApiParam(ARCHIVE_ID)
  @ApiAcceptedResponse({ type: ArchiveDeleteAcceptedDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "CSRF_HEADER_REQUIRED",
    "ARCHIVE_CODE_MISMATCH",
    "ARCHIVE_NOT_FOUND",
    "ARCHIVE_NOT_READY",
  )
  delete(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: DeleteArchiveDto,
    @CurrentActor() actor: Actor,
  ): Promise<ArchiveDeleteAcceptedDto> {
    return this.archives.requestDelete(id, body.code, actor);
  }
}
