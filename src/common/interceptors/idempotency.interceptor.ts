import {
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from "@nestjs/common";
import { createHash } from "node:crypto";

import type { Request } from "express";
import { concatMap, of, type Observable } from "rxjs";

import {
  IdempotencyRepository,
  type IdempotencyRecord,
} from "../../db/repositories/idempotency.repo";
import { ManagerError } from "../../errors";

export const IDEMPOTENCY_KEY_HEADER = "idempotency-key";

/**
 * Replays the stored response when a POST is retried with the same `Idempotency-Key` and the
 * same body, and rejects the same key with a different body. Without this a client retrying
 * after a timeout would get a second, differently-salted signature for one intended action.\n *\n * The same key is forwarded upstream by the services below, so the protection holds even when the\n * retry arrives after this service has already returned but before the caller saw the response.
 *
 * Only successful responses are stored. An exception skips the mapping below, so a retry after
 * a transient failure still reaches the handler.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(private readonly repository: IdempotencyRepository) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const key = context.switchToHttp().getRequest<Request>().header(IDEMPOTENCY_KEY_HEADER)?.trim();
    if (!key) return next.handle();

    // Hashed from the raw body: pipes transform the handler's argument, not the request, so
    // this sees exactly what the client sent, as the Express middleware did.
    const requestHash = hashBody(context.switchToHttp().getRequest<Request>().body);
    const stored = await this.repository.find(key);
    if (stored) return of(replayOrConflict(stored, requestHash));

    // The record is committed before the body is emitted, not alongside it: a client that
    // receives the response and immediately retries must find the key already stored, or it
    // gets a second signature for the one action this exists to prevent.
    return next.handle().pipe(
      concatMap(async (body: unknown) => {
        await this.repository.save(
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
      "This Idempotency-Key was used with a different request body",
    );
  }
  return JSON.parse(stored.responseJson);
}

/** Hashes the parsed body so key ordering and whitespace cannot make one request look like two. */
function hashBody(body: unknown): string {
  return createHash("sha256").update(canonicalize(body), "utf8").digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`);
  return `{${entries.join(",")}}`;
}
