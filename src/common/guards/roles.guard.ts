import { Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";

import type { ApiKeyRole } from "../../db/entities";
import { forbidden, internalError } from "../../errors";
import { ACTOR_PROPERTY, type AuthenticatedRequest } from "../actor";
import { IS_PUBLIC_KEY } from "../decorators/public.decorator";
import { ROLES_KEY } from "../decorators/roles.decorator";

/**
 * How far each role reaches. A route admits its listed roles and every role above them, so
 * `@Roles("operator")` admits operator and admin, and a route with no `@Roles` admits all three.
 */
const ROLE_RANK: Record<ApiKeyRole, number> = { readonly: 0, operator: 1, admin: 2 };

/**
 * Enforces `@Roles(...)` as a hierarchy: `admin` ⊃ `operator` ⊃ `readonly`.
 *
 * The superset is deliberate: an administrator locked out of the operational endpoints would
 * have to mint an operator key to do their own job, and would then keep it — which is worse for
 * the audit trail than admitting the admin key in the first place. `readonly` sits below both,
 * so every route that changes anything — all of which name `operator` or `admin` — refuses it.
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

    if (reaches(actor.role, required)) return true;

    throw forbidden(`This endpoint requires ${required.join(" or ")} credentials`, {
      requiredRoles: required,
      actorRole: actor.role,
    });
  }
}

/** Whether `role` is at or above the lowest role the route names. */
export function reaches(role: ApiKeyRole, required: readonly ApiKeyRole[]): boolean {
  const lowest = Math.min(...required.map((r) => ROLE_RANK[r]));
  return ROLE_RANK[role] >= lowest;
}
