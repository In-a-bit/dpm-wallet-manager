import { randomUUID } from "node:crypto";

import type { OpenAPIObject } from "@nestjs/swagger";

import { buildOpenApiDocument } from "../src/openapi";
import { startHarness, type Harness } from "../src/testing/harness";

const PASSWORD = "correct horse battery staple";
const ADMIN_UI_HEADERS = { "X-Requested-With": "dpmm-admin" };

/**
 * The admin UI's access model: the readonly key role, UI users and their roles, session cookies,
 * the CSRF header, and the account rules (last owner, lockout, sign-out on change).
 */
describe("admin UI access", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  /** Creates a UI user through the API, the way an owner (or the setup tool) does. */
  async function createUser(username: string, role: string, password = PASSWORD) {
    const created = await harness.post("/v1/ui-users", { body: { username, password, role } });
    expect(created.status).toBe(201);
    return created.body as { id: string };
  }

  /** Signs in and returns the `dpmm_session=…` cookie to send back. */
  async function signIn(username: string, password = PASSWORD): Promise<string> {
    const response = await harness.post("/v1/session/login", {
      apiKey: null,
      body: { username, password },
    });
    expect(response.status).toBe(200);
    return sessionCookie(response.headers["set-cookie"]);
  }

  describe("readonly API key", () => {
    // Walks the whole OpenAPI document, so a route added later is covered without editing this.
    it("reads everything but keys and users, and changes nothing", async () => {
      const doc = buildOpenApiDocument(harness.app);
      for (const [route, path] of routes(doc.paths)) {
        const [method] = route.split(" ") as [string];
        if (route.includes("/session/")) continue;
        const response = await send(harness, method, fillParams(path), harness.readonlyKey);
        const adminOnlyRead =
          route.startsWith("GET /v1/api-keys") && route !== "GET /v1/api-keys/self";
        const refused = method !== "GET" || adminOnlyRead || route === "GET /v1/ui-users";
        expect(`${route}: ${response.status === 403}`).toBe(`${route}: ${refused}`);
        if (!refused) expect(`${route}: ${response.status}`).not.toBe(`${route}: 401`);
      }
    });

    it("is minted with the ro code and identifies itself", async () => {
      expect(harness.readonlyKey).toMatch(/^dpmm_test_ro_/);
      const self = await harness.get("/v1/api-keys/self", { apiKey: harness.readonlyKey });
      expect(self.body).toMatchObject({ role: "readonly", userId: null });
    });
  });

  describe("sessions", () => {
    it("signs in, identifies the user, and signs out", async () => {
      await createUser("session-owner", "owner");
      const cookie = await signIn("Session-Owner");

      const me = await harness.get("/v1/session/me", { cookie });
      expect(me.status).toBe(200);
      expect(me.body).toMatchObject({
        user: { username: "session-owner", role: "owner" },
        actorRole: "admin",
      });

      const out = await harness.post("/v1/session/logout", { cookie, headers: ADMIN_UI_HEADERS });
      expect(out.status).toBe(200);
      expect(String(out.headers["set-cookie"])).toMatch(/Max-Age=0/);
      expect((await harness.get("/v1/session/me", { cookie })).status).toBe(401);
    });

    it("sets an HttpOnly, SameSite=Strict cookie", async () => {
      await createUser("cookie-check", "viewer");
      const response = await harness.post("/v1/session/login", {
        apiKey: null,
        body: { username: "cookie-check", password: PASSWORD },
      });
      const header = String(response.headers["set-cookie"]);
      expect(header).toMatch(/HttpOnly/);
      expect(header).toMatch(/SameSite=Strict/);
      expect(response.body).not.toHaveProperty("token");
    });

    it("answers a wrong password and an unknown user the same way", async () => {
      await createUser("enumeration", "viewer");
      const wrong = await harness.post("/v1/session/login", {
        apiKey: null,
        body: { username: "enumeration", password: "not the password at all" },
      });
      const unknown = await harness.post("/v1/session/login", {
        apiKey: null,
        body: { username: "nobody-by-this-name", password: "not the password at all" },
      });
      expect(wrong.status).toBe(401);
      expect(unknown.status).toBe(401);
      expect(wrong.body).toEqual(unknown.body);
    });

    it("locks a username out after five failures from one address", async () => {
      await createUser("locked", "viewer");
      for (let attempt = 0; attempt < 5; attempt++) {
        await harness.post("/v1/session/login", {
          apiKey: null,
          body: { username: "locked", password: "wrong wrong wrong" },
        });
      }
      const sixth = await harness.post("/v1/session/login", {
        apiKey: null,
        body: { username: "locked", password: PASSWORD },
      });
      expect(sixth.status).toBe(429);
      expect(sixth.body.error.code).toBe("RATE_LIMITED");
    });

    it("refuses a change without the CSRF header, and allows it with", async () => {
      await createUser("csrf-owner", "owner");
      const cookie = await signIn("csrf-owner");
      const body = { username: "made-by-csrf-owner", password: PASSWORD, role: "viewer" };

      const without = await harness.post("/v1/ui-users", { cookie, body });
      expect(without.status).toBe(403);
      expect(without.body.error.code).toBe("CSRF_HEADER_REQUIRED");

      const withHeader = await harness.post("/v1/ui-users", {
        cookie,
        body,
        headers: ADMIN_UI_HEADERS,
      });
      expect(withHeader.status).toBe(201);
      // A read needs no header: the page's GETs carry it anyway, but a link must still work.
      expect((await harness.get("/v1/wallets", { cookie })).status).toBe(200);
    });

    it("gives each UI role exactly its API role's reach", async () => {
      await createUser("a-viewer", "viewer");
      await createUser("an-operator", "operator");
      const viewer = await signIn("a-viewer");
      const operator = await signIn("an-operator");

      expect((await harness.get("/v1/wallets", { cookie: viewer })).status).toBe(200);
      expect((await harness.get("/v1/api-keys", { cookie: viewer })).status).toBe(403);
      expect((await harness.get("/v1/ui-users", { cookie: viewer })).status).toBe(403);
      const viewerCreate = await harness.post("/v1/wallets", {
        cookie: viewer,
        headers: ADMIN_UI_HEADERS,
        body: { externalId: "viewer-try" },
      });
      expect(viewerCreate.status).toBe(403);

      expect((await harness.get("/v1/api-keys", { cookie: operator })).status).toBe(403);
      const operatorCreate = await harness.post("/v1/wallets", {
        cookie: operator,
        headers: ADMIN_UI_HEADERS,
        body: { externalId: `operator-${randomUUID()}` },
      });
      expect(operatorCreate.status).toBe(201);
    });

    it("records which person acted, in the audit trail and on keys", async () => {
      const owner = await createUser("auditing-owner", "owner");
      const cookie = await signIn("auditing-owner");
      const minted = await harness.post("/v1/api-keys", {
        cookie,
        headers: ADMIN_UI_HEADERS,
        body: { role: "readonly", name: "made-in-the-ui" },
      });
      expect(minted.status).toBe(201);
      expect(minted.body).toMatchObject({ createdByUserId: owner.id, createdByKeyId: null });

      const audit = await harness.get("/v1/audit", {
        query: { actorUserId: owner.id, action: "key.create" },
      });
      expect(audit.body.items[0]).toMatchObject({
        actorUsername: "auditing-owner",
        actorRole: "admin",
      });
      const logins = await harness.get("/v1/audit", {
        query: { actorUserId: owner.id, action: "session.login" },
      });
      expect(logins.body.total).toBeGreaterThan(0);
    });
  });

  describe("accounts", () => {
    it("ends every session of a user who is disabled", async () => {
      const user = await createUser("to-disable", "viewer");
      const cookie = await signIn("to-disable");
      const disabled = await harness.patch(`/v1/ui-users/${user.id}`, {
        body: { status: "disabled" },
      });
      expect(disabled.status).toBe(200);
      expect((await harness.get("/v1/wallets", { cookie })).status).toBe(401);
      expect(
        (
          await harness.post("/v1/session/login", {
            apiKey: null,
            body: { username: "to-disable", password: PASSWORD },
          })
        ).status,
      ).toBe(401);
    });

    it("signs out other browsers on a password change, keeping this one", async () => {
      await createUser("changing", "viewer");
      const here = await signIn("changing");
      const elsewhere = await signIn("changing");
      const changed = await harness.post("/v1/session/password", {
        cookie: here,
        headers: ADMIN_UI_HEADERS,
        body: { currentPassword: PASSWORD, newPassword: "a brand new long passphrase" },
      });
      expect(changed.status).toBe(200);
      expect((await harness.get("/v1/session/me", { cookie: here })).status).toBe(200);
      expect((await harness.get("/v1/session/me", { cookie: elsewhere })).status).toBe(401);
      await signIn("changing", "a brand new long passphrase");
    });

    it("refuses a wrong current password and a short new one", async () => {
      await createUser("strict", "viewer");
      const cookie = await signIn("strict");
      const wrongCurrent = await harness.post("/v1/session/password", {
        cookie,
        headers: ADMIN_UI_HEADERS,
        body: { currentPassword: "not it at all, sorry", newPassword: "another long passphrase" },
      });
      expect(wrongCurrent.status).toBe(400);
      const short = await harness.post("/v1/session/password", {
        cookie,
        headers: ADMIN_UI_HEADERS,
        body: { currentPassword: PASSWORD, newPassword: "short" },
      });
      expect(short.status).toBe(400);
    });

    it("never leaves the install without an active owner", async () => {
      const owners = (await harness.get("/v1/ui-users")).body.items.filter(
        (u: { role: string; status: string }) => u.role === "owner" && u.status === "active",
      );
      // Demote every owner but one, then the last one must be refused.
      for (const owner of owners.slice(1)) {
        expect(
          (await harness.patch(`/v1/ui-users/${owner.id}`, { body: { role: "viewer" } })).status,
        ).toBe(200);
      }
      const last = owners[0] as { id: string };
      const demote = await harness.patch(`/v1/ui-users/${last.id}`, { body: { role: "viewer" } });
      expect(demote.status).toBe(409);
      expect(demote.body.error.code).toBe("LAST_OWNER");
      const disable = await harness.patch(`/v1/ui-users/${last.id}`, {
        body: { status: "disabled" },
      });
      expect(disable.body.error.code).toBe("LAST_OWNER");
    });

    it("treats usernames case-insensitively", async () => {
      await createUser("CaseUser", "viewer");
      const again = await harness.post("/v1/ui-users", {
        body: { username: "caseuser", password: PASSWORD, role: "viewer" },
      });
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe("USERNAME_TAKEN");
    });

    it("never returns a password hash", async () => {
      const listed = await harness.get("/v1/ui-users");
      expect(JSON.stringify(listed.body)).not.toMatch(/scrypt|passwordHash|password_hash/);
    });
  });
});

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

function routes(paths: OpenAPIObject["paths"]): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item).filter((key) => HTTP_METHODS.has(key))) {
      found.push([`${method.toUpperCase()} ${path}`, path]);
    }
  }
  return found;
}

function fillParams(path: string): string {
  return path.replace(/\{[^}]+\}/g, randomUUID());
}

function send(harness: Harness, method: string, path: string, apiKey: string) {
  const options = { apiKey, body: {} };
  switch (method) {
    case "GET":
      return harness.get(path, { apiKey });
    case "POST":
      return harness.post(path, options);
    case "PATCH":
      return harness.patch(path, options);
    default:
      return harness.del(path, { apiKey });
  }
}

function sessionCookie(header: string | string[] | undefined): string {
  const line = (Array.isArray(header) ? header : [header ?? ""]).find((h) =>
    h.startsWith("dpmm_session="),
  );
  if (!line) throw new Error("no session cookie was set");
  return line.split(";")[0] as string;
}
