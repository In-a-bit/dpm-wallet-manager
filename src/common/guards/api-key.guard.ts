import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ApiKeyAuthenticator } from "../../api-keys/api-key-authenticator";
import { ManagerError, unauthorized } from "../../errors";
import { CSRF_HEADER, CSRF_HEADER_VALUE, readSessionCookie } from "../../session/session-cookie";
import { SessionService, toActor } from "../../session/session.service";
import { ACTOR_PROPERTY, UI_SESSION_PROPERTY, type AuthenticatedRequest } from "../actor";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

export const API_KEY_HEADER = "x-api-key";

/** Methods that change nothing, and so need no CSRF header from a cookie-authenticated caller. */
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Authenticates every request and attaches the actor: from `X-API-Key` when present, otherwise
 * from the admin UI's session cookie.
 *
 * Registered globally, so a new controller is guarded by default and has to opt out with
 * `@Public()` rather than remembering to opt in — the failure mode of the reverse is an
 * unauthenticated route nobody notices.
 *
 * A browser sends its cookie on every request to this origin, including ones another site
 * triggers, so a cookie-authenticated request that changes anything must also carry
 * `X-Requested-With: dpmm-admin` — a header another site cannot add (see `session-cookie.ts`).
 * An API key, which a browser never attaches on its own, needs no such proof.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authenticator: ApiKeyAuthenticator,
    private readonly sessions: SessionService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = request.header(API_KEY_HEADER);
    if (presented) {
      request[ACTOR_PROPERTY] = await this.authenticator.authenticate(presented, {
        ip: request.ip ?? null,
        path: request.path,
      });
      return true;
    }
    await this.authenticateSession(request);
    return true;
  }

  private async authenticateSession(request: AuthenticatedRequest): Promise<void> {
    const token = readSessionCookie(request);
    const found = token ? await this.sessions.authenticate(token) : undefined;
    if (!token || !found) throw unauthorized("Missing or invalid API key or session");
    if (!SAFE_METHODS.has(request.method) && request.header(CSRF_HEADER) !== CSRF_HEADER_VALUE) {
      throw new ManagerError(
        "CSRF_HEADER_REQUIRED",
        `Requests from the admin UI must send ${CSRF_HEADER}: ${CSRF_HEADER_VALUE}`,
      );
    }
    request[ACTOR_PROPERTY] = toActor(found.user);
    request[UI_SESSION_PROPERTY] = {
      sessionId: found.session.id,
      token,
      expiresAt: found.session.expiresAt,
    };
  }

  private isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true
    );
  }
}
