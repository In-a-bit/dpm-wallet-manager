import { Body, Controller, Get, HttpCode, HttpStatus, Param, Patch, Post } from "@nestjs/common";
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
import { CreateUiUserDto, UiUserDto, UiUserPageDto, UpdateUiUserDto } from "./dto/ui-user.dto";
import { UiUsersService } from "./ui-users.service";

const USER_ID = { name: "id", format: "uuid", description: "The admin UI user's id." } as const;

/**
 * Admin UI accounts: who may sign in to the admin UI, and with which role. Admin only — an owner
 * signed in to the UI, or an admin API key.
 */
@ApiTags("ui-users")
@ApiAuth()
@Controller("ui-users")
export class UiUsersController {
  constructor(private readonly users: UiUsersService) {}

  /**
   * List admin UI users.
   *
   * Every account with its role, status and last sign-in, oldest first. Never a password or hash.
   */
  @Get()
  @Roles("admin")
  @ApiOperation({ operationId: "listUiUsers", summary: "List admin UI users" })
  @ApiOkResponse({ type: UiUserPageDto })
  async list(): Promise<UiUserPageDto> {
    const items = await this.users.list();
    return { items, total: items.length };
  }

  /**
   * Create an admin UI user.
   *
   * `owner` acts as an admin key, `operator` as an operator key, `viewer` as a readonly key. The
   * password needs at least 12 characters and is stored only as a scrypt hash.
   */
  @Post()
  @Roles("admin")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: "createUiUser", summary: "Create an admin UI user" })
  @ApiCreatedResponse({ type: UiUserDto })
  @ApiErrors("VALIDATION_FAILED", "USERNAME_TAKEN", "CSRF_HEADER_REQUIRED")
  create(@Body() body: CreateUiUserDto, @CurrentActor() actor: Actor): Promise<UiUserDto> {
    return this.users.create(body, actor);
  }

  /**
   * Change an admin UI user's role, status or password.
   *
   * Disabling the user or setting a new password signs them out everywhere. Refuses to disable
   * or demote the last active owner.
   */
  @Patch(":id")
  @Roles("admin")
  @ApiOperation({ operationId: "updateUiUser", summary: "Change an admin UI user" })
  @ApiParam(USER_ID)
  @ApiOkResponse({ type: UiUserDto })
  @ApiErrors("VALIDATION_FAILED", "UI_USER_NOT_FOUND", "LAST_OWNER", "CSRF_HEADER_REQUIRED")
  update(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: UpdateUiUserDto,
    @CurrentActor() actor: Actor,
  ): Promise<UiUserDto> {
    return this.users.update(id, body, actor);
  }
}
