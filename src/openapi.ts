import type { INestApplication } from "@nestjs/common";
import { DocumentBuilder, SwaggerModule, type OpenAPIObject } from "@nestjs/swagger";

import { API_KEY_SECURITY } from "./common/decorators/api-auth.decorator";

/**
 * The OpenAPI document, generated from the controllers and DTOs by the CLI plugin.
 *
 * In its own module rather than in `main.ts` because `main.ts` calls `bootstrap()` at the top
 * level: importing it to build a document would start a server instead.
 *
 * `test/openapi.e2e-spec.ts` asserts the result is complete — every operation summarised, every
 * response and error typed. Documentation checked only by eye stops being true within a release
 * or two.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  return SwaggerModule.createDocument(
    app,
    new DocumentBuilder()
      .setTitle("dpm-wallet-manager")
      .setDescription(
        "Policy, directory and API-key layer in front of dpm-wallet.\n\n" +
          "**Sign-only.** Every response is a signed artefact for the caller to submit — orders " +
          "go to the CLOB, meta-transactions to relayer-api's `/submit`. This service never " +
          "broadcasts anything.\n\n" +
          "Authenticate with `X-API-Key`. Two roles: `admin` for administration, `operator` for " +
          "operations; admin is a superset of operator. Signing routes accept `Idempotency-Key`.",
      )
      .setVersion("1")
      // Declared, but not required globally: `@ApiAuth()` applies it per controller, so
      // `/v1/health` — the one public route — is not documented as needing a credential.
      .addApiKey({ type: "apiKey", name: "X-API-Key", in: "header" }, API_KEY_SECURITY)
      .addTag("platform", "Custody mode and the two platform wallets")
      .addTag("wallets", "The wallet directory and its lifecycle")
      .addTag("orders", "Signed orders and cancels, routed by custody mode")
      .addTag("meta-tx", "Proxy meta-transactions, gated by the funds policy")
      .addTag("api-keys", "Credential administration")
      .addTag("audit", "The decision log and the artefact log")
      .addTag("health", "Liveness")
      .build(),
  );
}
