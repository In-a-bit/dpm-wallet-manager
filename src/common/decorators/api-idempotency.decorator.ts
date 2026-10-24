import { applyDecorators, SetMetadata } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";

/** Set by `@Idempotent()`; the interceptor acts only on routes that carry it. */
export const IDEMPOTENT_METADATA = "dpmm:idempotent";

/**
 * Opts a route into `Idempotency-Key` handling (see `IdempotencyInterceptor`) and documents the
 * header. Only the POSTs that sign or move value carry it — never key, session or user routes,
 * whose responses hold secrets that must not be stored for replay.
 */
export function Idempotent() {
  return applyDecorators(SetMetadata(IDEMPOTENT_METADATA, true), ApiIdempotencyKey());
}

/**
 * Documents the `Idempotency-Key` header on a route that signs something.
 *
 * The plugin infers a bare, undocumented parameter from the `@Headers("idempotency-key")`
 * argument, so the name here matches it exactly — otherwise the same header appears twice in the
 * schema, once described and once not.
 *
 * Worth describing at all because it is the one header a caller genuinely has to know about:
 * without it a retried request produces a second, differently-salted signature for one intended
 * action.
 */
export function ApiIdempotencyKey() {
  return applyDecorators(
    ApiHeader({
      name: "idempotency-key",
      required: false,
      description:
        "An opaque key of the caller's choosing. Retrying with the same key and the same body " +
        "replays the original response instead of signing again; the same key with a different " +
        "body is refused with `IDEMPOTENCY_CONFLICT`. Keys are honoured for 24 hours. The key is forwarded to dpm-wallet, so the " +
        "protection holds even if this service returned before the caller saw the response.",
      example: "trade-2026-08-26-0001",
    }),
  );
}
