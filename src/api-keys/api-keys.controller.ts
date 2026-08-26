import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { IsUuidPipe } from "../common/pipes/uuid.pipe";
import { ApiKeyService } from "./api-key.service";
import { CreateApiKeyDto, RotateApiKeyDto } from "./dto/api-key.dto";
import {
  ActorDto,
  ApiKeyDto,
  ApiKeyPageDto,
  MintedApiKeyDto,
  RotateApiKeyResponseDto,
} from "./dto/api-key-response.dto";

const KEY_ID = { name: "id", format: "uuid", description: "The API key's id." } as const;

/**
 * Key administration. Everything here is admin-only except `self`, which any authenticated key
 * may call — the UI uses it as a session probe, and refusing an operator key its own identity
 * would mean the UI could not tell an operator what they are signed in as.
 */
@ApiTags("api-keys")
@ApiAuth()
@Controller("api-keys")
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  /**
   * Identify the calling key.
   *
   * The UI's session probe: it answers "who am I signed in as" without needing admin rights.
   * Declared before `:id` so the literal segment is not parsed as an identifier.
   */
  @Get("self")
  @ApiOperation({ operationId: "getSelf", summary: "Identify the calling key" })
  @ApiOkResponse({ type: ActorDto })
  self(@CurrentActor() actor: Actor): ActorDto {
    return actor;
  }

  /**
   * List every key's metadata.
   *
   * Role, prefix, name, status, expiry, last use and rotation lineage — everything a key
   * administration screen needs. Never returns a secret; use `POST /v1/api-keys/{id}/reveal` for
   * that, one key at a time and with an audit row behind it.
   */
  @Get()
  @Roles("admin")
  @ApiOperation({ operationId: "listApiKeys", summary: "List API keys" })
  @ApiOkResponse({ type: ApiKeyPageDto })
  async list(): Promise<ApiKeyPageDto> {
    const items = await this.keys.list();
    return { items, total: items.length };
  }

  /**
   * Fetch one key's metadata.
   *
   * Never the secret — `POST /v1/api-keys/{id}/reveal` is the only way to see that, and it is
   * audited.
   */
  @Get(":id")
  @Roles("admin")
  @ApiOperation({ operationId: "getApiKey", summary: "Get one API key" })
  @ApiParam(KEY_ID)
  @ApiOkResponse({ type: ApiKeyDto })
  @ApiErrors("VALIDATION_FAILED", "API_KEY_NOT_FOUND")
  get(@Param("id", IsUuidPipe) id: string): Promise<ApiKeyDto> {
    return this.keys.get(id);
  }

  /**
   * Mint a key.
   *
   * The plaintext comes back exactly once, here. It is recoverable afterwards only through an
   * explicit, audited reveal.
   */
  @Post()
  @Roles("admin")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: "createApiKey", summary: "Mint an API key" })
  @ApiCreatedResponse({ type: MintedApiKeyDto })
  @ApiErrors("VALIDATION_FAILED")
  create(@Body() body: CreateApiKeyDto, @CurrentActor() actor: Actor): Promise<MintedApiKeyDto> {
    return this.keys.create(body, actor);
  }

  /**
   * Rotate a key, with an overlap.
   *
   * Mints a replacement with the same role and gives the outgoing key a deadline instead of
   * killing it, so callers can be redeployed one at a time. Pass `graceSeconds: 0` to revoke it
   * immediately, which is the right response to a leak.
   */
  @Post(":id/rotate")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "rotateApiKey", summary: "Rotate an API key, with an overlap" })
  @ApiParam(KEY_ID)
  @ApiOkResponse({ type: RotateApiKeyResponseDto })
  @ApiErrors("VALIDATION_FAILED", "API_KEY_NOT_FOUND", "API_KEY_REVOKED")
  rotate(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: RotateApiKeyDto,
    @CurrentActor() actor: Actor,
  ): Promise<RotateApiKeyResponseDto> {
    return this.keys.rotate(id, body.graceSeconds, actor);
  }

  /**
   * Reveal a key's plaintext.
   *
   * POST rather than GET because this returns a live credential, and a GET would end up in browser
   * history, in a proxy log, and in anything that retries idempotent methods on its own. Admin
   * only, limited to five calls a minute per key, and always audited with the acting key's id.
   */
  @Post(":id/reveal")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "revealApiKey", summary: "Reveal an API key's plaintext" })
  @ApiParam(KEY_ID)
  @ApiOkResponse({ type: MintedApiKeyDto })
  @ApiErrors("VALIDATION_FAILED", "API_KEY_NOT_FOUND", "RATE_LIMITED")
  reveal(
    @Param("id", IsUuidPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<MintedApiKeyDto> {
    return this.keys.reveal(id, actor);
  }

  /**
   * Revoke a key immediately.
   *
   * Idempotent. Refuses to revoke the last usable admin key, which would lock this install out of
   * its own administration with no way back short of editing the database.
   */
  @Delete(":id")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "revokeApiKey", summary: "Revoke an API key" })
  @ApiParam(KEY_ID)
  @ApiOkResponse({ type: ApiKeyDto })
  @ApiErrors("VALIDATION_FAILED", "API_KEY_NOT_FOUND", "LAST_ADMIN_KEY")
  revoke(@Param("id", IsUuidPipe) id: string, @CurrentActor() actor: Actor): Promise<ApiKeyDto> {
    return this.keys.revoke(id, actor);
  }
}
