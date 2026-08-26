import { applyDecorators } from "@nestjs/common";
import { ApiHeader } from "@nestjs/swagger";

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
        "body is refused with `IDEMPOTENCY_CONFLICT`. The key is forwarded to dpm-wallet, so the " +
        "protection holds even if this service returned before the caller saw the response.",
      example: "trade-2026-08-26-0001",
    }),
  );
}
