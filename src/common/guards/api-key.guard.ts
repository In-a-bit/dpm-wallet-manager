import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import { ApiKeyAuthenticator } from "../../api-keys/api-key-authenticator";
import { unauthorized } from "../../errors";
import { ACTOR_PROPERTY, type AuthenticatedRequest } from "../actor";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";

export const API_KEY_HEADER = "x-api-key";

/**
 * Authenticates every request and attaches the actor.
 *
 * Registered globally, so a new controller is guarded by default and has to opt out with
 * `@Public()` rather than remembering to opt in — the failure mode of the reverse is an
 * unauthenticated route nobody notices.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly authenticator: ApiKeyAuthenticator,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const presented = request.header(API_KEY_HEADER);
    if (!presented) throw unauthorized();

    request[ACTOR_PROPERTY] = await this.authenticator.authenticate(presented, {
      ip: request.ip ?? null,
      path: request.path,
    });
    return true;
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
