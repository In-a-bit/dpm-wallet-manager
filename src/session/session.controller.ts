import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Req,
  Res,
} from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import {
  CurrentActor,
  UI_SESSION_PROPERTY,
  type Actor,
  type AuthenticatedRequest,
  type UiSessionContext,
} from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { Public } from "../common/decorators/public.decorator";
import type { Config } from "../config";
import { UI_ROLE_TO_API_ROLE } from "../db/entities";
import { unauthorized } from "../errors";
import { CONFIG } from "../tokens";
import { toView } from "../ui-users/ui-users.service";
import {
  ChangePasswordDto,
  LoggedOutDto,
  LoginDto,
  PasswordChangedDto,
  SessionDto,
} from "./dto/session.dto";
import { clearSessionCookie, readSessionCookie, setSessionCookie } from "./session-cookie";
import { SessionService } from "./session.service";
import type { UiUser } from "../db/repositories/ui-user.repo";
import { UiUserRepository } from "../db/repositories/ui-user.repo";

/**
 * Sign-in for the admin UI. A successful sign-in sets an HttpOnly, SameSite=Strict session
 * cookie; the browser then sends it on every call, and every other route accepts it in place of
 * an API key. API keys never need any of this.
 */
@ApiTags("session")
@Controller("session")
export class SessionController {
  constructor(
    private readonly sessions: SessionService,
    private readonly users: UiUserRepository,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * Sign in to the admin UI.
   *
   * Sets the session cookie. A wrong username and a wrong password get the same answer, and five
   * failures for one username from one address lock that pair out for fifteen minutes.
   */
  @Post("login")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "login", summary: "Sign in to the admin UI" })
  @ApiOkResponse({ type: SessionDto })
  @ApiErrors("VALIDATION_FAILED", "UNAUTHORIZED", "RATE_LIMITED", "INTERNAL_ERROR")
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const signedIn = await this.sessions.login(body.username, body.password, context(request));
    setSessionCookie(response, signedIn.token, this.config.uiCookieSecure);
    return toSession(signedIn.user, signedIn.session.expiresAt);
  }

  /**
   * Sign out of the admin UI.
   *
   * Ends this browser's session and clears its cookie. Safe to call when already signed out.
   */
  @Post("logout")
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "logout", summary: "Sign out of the admin UI" })
  @ApiOkResponse({ type: LoggedOutDto })
  @ApiErrors("INTERNAL_ERROR")
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LoggedOutDto> {
    const token = readSessionCookie(request);
    if (token) await this.sessions.logout(token, context(request));
    clearSessionCookie(response, this.config.uiCookieSecure);
    return { loggedOut: true };
  }

  /**
   * Who is signed in.
   *
   * The admin UI's session probe. Answers 401 when the browser is not signed in, and for an API
   * key, which has no session to describe — use `GET /v1/api-keys/self` for that.
   */
  @Get("me")
  @ApiAuth()
  @ApiOperation({ operationId: "getSession", summary: "Who is signed in" })
  @ApiOkResponse({ type: SessionDto })
  async me(
    @CurrentActor() actor: Actor,
    @Req() request: AuthenticatedRequest,
  ): Promise<SessionDto> {
    const session = requireSession(request);
    const user = actor.userId ? await this.users.findById(actor.userId) : null;
    if (!user) throw unauthorized("Not signed in to the admin UI");
    return toSession(user, session.expiresAt);
  }

  /**
   * Change your own password.
   *
   * Needs the current password, and signs out every other browser you are signed in on.
   */
  @Post("password")
  @ApiAuth()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "changePassword", summary: "Change your own password" })
  @ApiOkResponse({ type: PasswordChangedDto })
  @ApiErrors("VALIDATION_FAILED", "CSRF_HEADER_REQUIRED")
  async changePassword(
    @Body() body: ChangePasswordDto,
    @CurrentActor() actor: Actor,
    @Req() request: AuthenticatedRequest,
  ): Promise<PasswordChangedDto> {
    const session = requireSession(request);
    await this.sessions.changePassword(
      actor,
      session.token,
      body.currentPassword,
      body.newPassword,
    );
    return { changed: true };
  }
}

function requireSession(request: AuthenticatedRequest): UiSessionContext {
  const session = request[UI_SESSION_PROPERTY];
  if (!session) throw unauthorized("Not signed in to the admin UI");
  return session;
}

function toSession(user: UiUser, expiresAt: string): SessionDto {
  const view = toView(user);
  return {
    user: view,
    actorRole: UI_ROLE_TO_API_ROLE[user.role],
    expiresAt,
  };
}

function context(request: Request) {
  return { ip: request.ip ?? null, userAgent: request.header("user-agent") ?? null };
}
