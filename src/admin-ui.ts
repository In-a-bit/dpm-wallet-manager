import { existsSync } from "node:fs";
import { join } from "node:path";

import type { NestExpressApplication } from "@nestjs/platform-express";
import express, { type NextFunction, type Request, type Response } from "express";

/** Where the admin UI is served from. Outside the `/v1` API prefix, and outside the OpenAPI document. */
export const ADMIN_UI_PATH = "/admin";

/**
 * The built UI (`ui/`, emitted by Vite into `dist/ui`). Resolved off this file's own directory,
 * like the entity globs in `db/client.ts`, so it is right from `dist/` in the image. Absent when
 * running from `src/` without a UI build, in which case nothing is served at `/admin`.
 */
const UI_DIR = join(__dirname, "ui");

/**
 * The page loads only its own script and stylesheet: nothing inline, nothing from another
 * origin, and it may not be framed — which is what keeps a hostile page from overlaying it.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};

/**
 * Serves the admin UI at `/admin`, falling back to its `index.html` for any path the single-page
 * app routes itself, and sends `/` there too. Returns false when no UI build is present.
 */
export function serveAdminUi(app: NestExpressApplication, uiDir: string = UI_DIR): boolean {
  const index = join(uiDir, "index.html");
  if (!existsSync(index)) return false;
  const server = app.getHttpAdapter().getInstance();
  server.use(ADMIN_UI_PATH, withSecurityHeaders);
  server.use(
    ADMIN_UI_PATH,
    express.static(uiDir, { index: false, maxAge: "1h", immutable: false }),
  );
  server.get(/^\/admin(\/.*)?$/, (_request: Request, response: Response) => {
    response.setHeader("Cache-Control", "no-store");
    response.sendFile(index);
  });
  server.get("/", (_request: Request, response: Response) =>
    response.redirect(`${ADMIN_UI_PATH}/`),
  );
  return true;
}

function withSecurityHeaders(_request: Request, response: Response, next: NextFunction): void {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) response.setHeader(name, value);
  next();
}
