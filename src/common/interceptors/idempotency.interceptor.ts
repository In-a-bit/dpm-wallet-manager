import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { createHash } from "node:crypto";

import type { Request } from "express";
import { concatMap, of, type Observable } from "rxjs";
import { Reflector } from "@nestjs/core";

import {
  IdempotencyRepository,
  type IdempotencyRecord,
} from "../../db/repositories/idempotency.repo";
import { ManagerError, validationFailed } from "../../errors";
import { ACTOR_PROPERTY, actorScope, type AuthenticatedRequest } from "../actor";
import { IDEMPOTENT_METADATA } from "../decorators/api-idempotency.decorator";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/** Callers' keys are at most this long; dpm-wallet takes up to 256 once this service adds its own parts. */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

/**
 * Replays the stored response when a POST is retried with the same `Idempotency-Key` on the same
 * route and with the same body, and rejects the same key on any other request. Without this a
 * client retrying after a timeout would get a second, differently-salted signature for one
 * intended action.
 *
 * The method and path are part of what is compared, not just the body: `/withdraw` and
 * `/transfers` take the same body, as do two wallets' transfers, and replaying one as the other
 * would hand back a signature nobody relayed, or report a transfer that never happened as done.
 *
 * The same key is forwarded upstream by the services below, so the protection holds even when the
 * retry arrives after this service has already returned but before the caller saw the response.
 *
 * Opt-in: only routes marked `@Idempotent()` are touched, and only a POST. A key is scoped to the
 * actor (API key id or `user:<id>`), so another caller reusing it is simply a fresh key and can
 * neither replay nor detect the original. Keys are honoured for 24 hours.
 *
 * Only successful responses are stored. An exception skips the mapping below, so a retry after
 * a transient failure still reaches the handler.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly repository: IdempotencyRepository,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.method !== "POST") return next.handle();
    if (
      !this.reflector.getAllAndOverride<boolean>(IDEMPOTENT_METADATA, [
        context.getHandler(),
        context.getClass(),
      ])
    ) {
      return next.handle();
    }
    const key = request.header(IDEMPOTENCY_KEY_HEADER)?.trim();
    const actor = request[ACTOR_PROPERTY];
    if (!key || !actor) return next.handle();
    if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw validationFailed(
        `${IDEMPOTENCY_KEY_HEADER} must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`,
      );
    }
    const actorId = actorScope(actor);

    // Hashed from the raw body: pipes transform the handler's argument, not the request, so
    // this sees exactly what the client sent, as the Express middleware did.
    const requestHash = hashRequest(request);
    const stored = await this.repository.find(actorId, key);
    if (stored) return of(replayOrConflict(stored, requestHash));

    // The record is committed before the body is emitted, not alongside it: a client that
    // receives the response and immediately retries must find the key already stored, or it
    // gets a second signature for the one action this exists to prevent.
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.repository.save(
          actorId,
          key,
          { requestHash, responseJson: JSON.stringify(body) },
          new Date().toISOString(),
        );
        return body;
      }),
    );
  }
}

function replayOrConflict(stored: IdempotencyRecord, requestHash: string): unknown {
  if (stored.requestHash !== requestHash) {
    throw new ManagerError(
      "IDEMPOTENCY_CONFLICT",
      "This Idempotency-Key was used for a different request (route, wallet or body)",
    );
  }
  return JSON.parse(stored.responseJson);
}

/**
 * Hashes the method, the path (which carries the wallet id) and the parsed body, so key ordering
 * and whitespace cannot make one request look like two, and two requests cannot look like one.
 * The query string is left out: no signing route reads one.
 */
function hashRequest(request: Request): string {
  const path = request.originalUrl.split("?")[0] ?? "";
  return createHash("sha256")
    .update(`${request.method} ${path}\n${canonicalize(request.body)}`, "utf8")
    .digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}
