import crypto from "node:crypto";
import http from "node:http";

import { ENVIRONMENTS } from "./environments";
import { SetupError } from "./platform-config";
import type { SetupService } from "./setup-service";
import { APP_CSS, APP_JS, INDEX_HTML } from "./ui";

export const PIN_HEADER = "x-setup-pin";

const MAX_BODY_BYTES = 16 * 1024;
const MAX_FAILED_PINS = 10;
const LOCKOUT_MS = 10 * 60 * 1000;

export type ServerOptions = {
  service: SetupService;
  pin: string;
  /** Where the builder's backend reaches the manager from outside the stack. */
  managerPublicUrl: string;
  /** Live checks for the status page, which report problems rather than throw. */
  liveStatus: () => Promise<unknown>;
};

type Route = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;

/**
 * The setup page and its JSON API. Plain node:http: the page is five routes and must start
 * without the configuration the rest of the service needs. Every /api route but the PIN check
 * itself requires the PIN, which the installer prints; wrong guesses lock the API for a while.
 */
export function createSetupServer(options: ServerOptions): http.Server {
  const pinGuard = new PinGuard(options.pin);
  const routes = apiRoutes(options, pinGuard);
  return http.createServer((req, res) => {
    void handle(req, res, routes, pinGuard).catch((err: unknown) => sendError(res, err));
  });
}

async function handle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  routes: Record<string, Route>,
  pinGuard: PinGuard,
): Promise<void> {
  const path = new URL(req.url ?? "/", "http://setup").pathname;
  if (req.method === "GET" && serveStatic(path, res)) return;
  if (path === "/favicon.ico") return void res.writeHead(204).end();
  const route = routes[`${req.method} ${path}`];
  if (!route) return sendJson(res, 404, { message: "Not found" });
  if (path !== "/api/session" && !pinGuard.allows(req.headers[PIN_HEADER])) {
    return sendJson(res, 401, { message: pinGuard.lockedMessage() ?? "Enter the setup PIN." });
  }
  await route(req, res);
}

function apiRoutes(options: ServerOptions, pinGuard: PinGuard): Record<string, Route> {
  const { service } = options;
  return {
    "POST /api/session": async (req, res) => {
      // The same guard as every other route, so guessing here counts towards the lockout.
      const { pin } = (await readJson(req)) as { pin?: string };
      if (pinGuard.allows(pin)) return sendJson(res, 200, {});
      sendJson(res, 401, { message: pinGuard.lockedMessage() ?? "That PIN is not right." });
    },
    "GET /api/state": async (_req, res) => {
      sendJson(res, 200, {
        ...service.view(),
        environments: ENVIRONMENTS,
        connection: connection(options),
      });
    },
    "POST /api/check-key": async (req, res) => {
      const checked = await service.checkKey((await readJson(req)) as never);
      sendJson(res, 200, {
        builderName: checked.platform.owner.name,
        owner: checked.platform.owner,
      });
    },
    "POST /api/start": async (req, res) => {
      await service.start((await readJson(req)) as never);
      sendJson(res, 202, service.view());
    },
    "POST /api/retry": async (_req, res) => {
      service.resume();
      sendJson(res, 202, service.view());
    },
    "GET /api/backup-kit": async (_req, res) => {
      const kit = service.backupKit();
      res.writeHead(200, {
        "Content-Type": "text/plain; charset=utf-8",
        "Content-Disposition": 'attachment; filename="dpm-custody-backup-kit.txt"',
        "Cache-Control": "no-store",
      });
      res.end(kit);
    },
    "POST /api/backup-acknowledged": async (_req, res) => {
      service.acknowledgeBackup();
      sendJson(res, 200, service.view());
    },
    "GET /api/live-status": async (_req, res) => {
      sendJson(res, 200, await options.liveStatus());
    },
  };
}

/** The backend's connection details, shown only once the backup kit is safely saved. */
function connection(options: ServerOptions): unknown {
  const details = options.service.connectionDetails();
  if (!details || !options.service.view().backupAcknowledged) return undefined;
  return { managerUrl: options.managerPublicUrl, operatorKey: details.operatorKey };
}

function serveStatic(path: string, res: http.ServerResponse): boolean {
  const assets: Record<string, [string, string]> = {
    "/": [INDEX_HTML, "text/html; charset=utf-8"],
    "/app.js": [APP_JS, "text/javascript; charset=utf-8"],
    "/app.css": [APP_CSS, "text/css; charset=utf-8"],
  };
  const asset = assets[path];
  if (!asset) return false;
  res.writeHead(200, {
    "Content-Type": asset[1],
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(asset[0]);
  return true;
}

async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new SetupError("The request is too large.");
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SetupError("The request was not valid JSON.");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body ?? {}));
}

/** A SetupError is meant for the person and shown as-is; anything else is a bug, logged. */
function sendError(res: http.ServerResponse, err: unknown): void {
  // Too late for a status code; ending the response is all that is left, and throwing here
  // would take the whole page down.
  if (res.headersSent) {
    console.error("[setup] error after the response started", err);
    return void res.end();
  }
  if (err instanceof SetupError) return sendJson(res, 400, { message: err.message });
  console.error("[setup] unexpected error", err);
  sendJson(res, 500, {
    message: "Something went wrong. Run ./dpm-custody logs and share the output.",
  });
}

/** Constant-time PIN comparison with a lockout after repeated misses. */
export class PinGuard {
  private failures = 0;
  private lockedUntil = 0;

  constructor(private readonly pin: string) {}

  matches(presented: unknown): boolean {
    if (typeof presented !== "string") return false;
    const expected = crypto.createHash("sha256").update(this.pin).digest();
    const actual = crypto.createHash("sha256").update(presented.trim()).digest();
    return crypto.timingSafeEqual(expected, actual);
  }

  allows(presented: unknown): boolean {
    if (Date.now() < this.lockedUntil) return false;
    if (this.matches(presented)) return true;
    if (++this.failures >= MAX_FAILED_PINS) {
      this.lockedUntil = Date.now() + LOCKOUT_MS;
      this.failures = 0;
    }
    return false;
  }

  lockedMessage(): string | undefined {
    if (Date.now() >= this.lockedUntil) return undefined;
    return "Too many wrong PINs. Wait ten minutes and try again.";
  }
}
