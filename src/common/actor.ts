import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

import type { ApiKeyRole } from "../db/entities";
import { internalError } from "../errors";

/** Who is making the request. Attached to the request by `ApiKeyGuard` once the key verifies. */
export type Actor = {
  keyId: string;
  role: ApiKeyRole;
  /** The non-secret handle, safe to log and to echo back. */
  prefix: string;
  name: string;
};

/** The property the guard writes and `@CurrentActor()` reads. */
export const ACTOR_PROPERTY = "actor";

export type AuthenticatedRequest = Request & { [ACTOR_PROPERTY]?: Actor };

/**
 * Injects the authenticated actor into a handler.
 *
 * Throws rather than returning undefined on a `@Public()` route: a handler asking for the actor
 * on a route with no authentication is a wiring mistake, and a silent `undefined` would surface
 * as a null actor id in the audit trail instead.
 */
export const CurrentActor = createParamDecorator((_data: unknown, context: ExecutionContext) => {
  const actor = context.switchToHttp().getRequest<AuthenticatedRequest>()[ACTOR_PROPERTY];
  if (!actor) throw internalError("Route asked for the actor but is not authenticated");
  return actor;
});
