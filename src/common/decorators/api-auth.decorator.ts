import { applyDecorators } from "@nestjs/common";
import { ApiSecurity } from "@nestjs/swagger";

import { ApiErrors } from "./api-errors.decorator";

/** The security scheme id registered in `main.ts`. */
export const API_KEY_SECURITY = "apiKey";

/**
 * Marks a controller as requiring `X-API-Key`, and documents the two failures every authenticated
 * route shares.
 *
 * Applied per controller rather than globally in `main.ts` so `/v1/health` — the one public route
 * — is not documented as needing a credential it does not need. A probe reading the schema should
 * not be told to authenticate.
 */
export function ApiAuth() {
  return applyDecorators(
    ApiSecurity(API_KEY_SECURITY),
    ApiErrors("UNAUTHORIZED", "INTERNAL_ERROR"),
  );
}
