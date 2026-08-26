import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { ApiKeyRole } from "../../db/entities";
import { forbidden, internalError } from "../../errors";
import { ACTOR_PROPERTY, type AuthenticatedRequest } from "../actor";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { ROLES_KEY } from "../decorators/roles.decorator";

/**
 * Enforces `@Roles(...)`, with `admin` as a superset of `operator`.
 *
 * The superset is deliberate: an administrator locked out of the operational endpoints would
 * have to mint an operator key to do their own job, and would then keep it — which is worse for
 * the audit trail than admitting the admin key in the first place.
 *
 * Runs after `ApiKeyGuard`, whose order in the provider list is what puts the actor on the
 * request before this reads it.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic =
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) === true;
    if (isPublic) return true;

    const required = this.reflector.getAllAndOverride<ApiKeyRole[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required || required.length === 0) return true;

    const actor = context.switchToHttp().getRequest<AuthenticatedRequest>()[ACTOR_PROPERTY];
    // Unreachable through the guard chain; a defensive throw rather than an implicit allow, since
    // getting this wrong would open an admin route to anyone.
    if (!actor) throw internalError("Role check ran before authentication");

    if (actor.role === "admin") return true;
    if (required.includes(actor.role)) return true;

    throw forbidden(`This endpoint requires ${required.join(" or ")} credentials`, {
      requiredRoles: required,
      actorRole: actor.role,
    });
  }
}
