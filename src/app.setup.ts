import type { NestExpressApplication } from "@nestjs/platform-express";

import type { Config } from "./config";

export const BASE_PATH = "v1";

/** Bodies here are small JSON documents; a tight cap stops an oversized one reaching validation. */
const MAX_BODY_SIZE = "64kb";

/**
 * Everything the app needs beyond its module graph. Shared with the end-to-end tests so they
 * exercise the same prefix, body cap, CORS policy and header behaviour the container runs with.
 *
 * The app must be created with `bodyParser: false`; registering a second JSON parser on top of
 * Nest's default would leave the default's 100kb limit in force and silently widen the cap.
 */
export function configureApp(app: NestExpressApplication, config: Config): void {
  app.getHttpAdapter().getInstance().disable("x-powered-by");
  app.useBodyParser("json", { limit: MAX_BODY_SIZE });
  app.setGlobalPrefix(BASE_PATH);
  // An explicit allowlist rather than `*`: the browser has to send X-API-Key, and a wildcard
  // origin would let any page a signed-in operator visits drive the backoffice API.
  if (config.corsOrigins.length > 0) {
    app.enableCors({
      origin: config.corsOrigins,
      allowedHeaders: ["Content-Type", "X-API-Key", "Idempotency-Key"],
      methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
      maxAge: 600,
    });
  }
}
