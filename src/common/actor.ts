import { createHash } from "node:crypto";

import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Request } from "express";

import type { ApiKeyRole } from "../db/entities";
import { internalError } from "../errors";

/**
 * Who is making the request. Attached by `ApiKeyGuard` once an API key or an admin UI session
 * verifies. Exactly one of `keyId` and `userId` is set.
 */
export type Actor = {
  /** The API key behind the request; null for a signed-in UI user. */
  keyId: string | null;
  /** The admin UI user behind the request; null for an API key. */
  userId: string | null;
  username: string | null;
  /** For a UI user, the API role their UI role maps to (see `UI_ROLE_TO_API_ROLE`). */
  role: ApiKeyRole;
  /** The non-secret handle, safe to log and to echo back: a key prefix, or `user:<username>`. */
  prefix: string;
  name: string;
  /**
   * The first key of this key's rotation chain, so a credential and its replacements count as one
   * caller for idempotency. Unset for a UI user, and when the key was never rotated.
   */
  lineageId?: string;
};

/** Who an idempotency key belongs to: the rotation root, else the key id, else `user:<id>`. */
export function actorScope(actor: Pick<Actor, "keyId" | "userId" | "lineageId">): string {
  return actor.lineageId ?? actor.keyId ?? `user:${actor.userId}`;
}

/**
 * The key sent to dpm-wallet for one upstream call. dpm-wallet replays a stored response to
 * anyone presenting the same key, so the caller's scope is part of it: another actor reusing a key
 * must not be handed this one's signature (or have its own transfer silently skipped).
 */
export function forwardedKey(
  actor: Pick<Actor, "keyId" | "userId" | "lineageId">,
  key: string,
  suffix: string,
): string {
  const scope = createHash("sha256").update(actorScope(actor), "utf8").digest("hex").slice(0, 16);
  return `${scope}:${key}:${suffix}`;
}

/** The property the guard writes and `@CurrentActor()` reads. */
export const ACTOR_PROPERTY = "actor";

/** The property the guard writes when the caller signed in through the admin UI. */
export const UI_SESSION_PROPERTY = "uiSession";

/** What the guard knows about a cookie-authenticated caller, beyond the actor. */
export type UiSessionContext = { sessionId: string; token: string; expiresAt: string };

export type AuthenticatedRequest = Request & {
  [ACTOR_PROPERTY]?: Actor;
  [UI_SESSION_PROPERTY]?: UiSessionContext;
};

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
