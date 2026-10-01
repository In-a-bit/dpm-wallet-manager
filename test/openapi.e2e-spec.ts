import type { OpenAPIObject, OperationObject, SchemaObject } from "@nestjs/swagger";

import { buildOpenApiDocument } from "../src/openapi";
import { startHarness, type Harness } from "../src/testing/harness";

/**
 * The generated OpenAPI document, checked for completeness.
 *
 * The point is not that Swagger runs — it is that documentation which is only reviewed by eye
 * stops being true within a release or two. A new endpoint, a new response field, or a new error
 * code has to fail this spec until it is described, which is the only way the schema stays a
 * contract a UI can be built against rather than a stale artefact.
 */
describe("openapi", () => {
  let harness: Harness;
  let doc: OpenAPIObject;

  beforeAll(async () => {
    harness = await startHarness();
    doc = buildOpenApiDocument(harness.app);
  });

  afterAll(async () => {
    await harness.close();
  });

  /** Every operation in the document, keyed the way a failure message should read. */
  const operations = (): [string, OperationObject][] =>
    Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.entries(item as Record<string, OperationObject>)
        .filter(([method]) => METHODS.includes(method))
        .map(([method, op]): [string, OperationObject] => [`${method.toUpperCase()} ${path}`, op]),
    );

  const METHODS = ["get", "post", "put", "patch", "delete"];

  /** The route table, spelled out. A new endpoint fails here until it is added deliberately. */
  const EXPECTED_ROUTES = [
    "GET /v1/health",
    "GET /v1/api-keys",
    "POST /v1/api-keys",
    "GET /v1/api-keys/self",
    "GET /v1/api-keys/{id}",
    "DELETE /v1/api-keys/{id}",
    "POST /v1/api-keys/{id}/reveal",
    "POST /v1/api-keys/{id}/rotate",
    "GET /v1/platform",
    "POST /v1/platform/master-wallet",
    "POST /v1/platform/operations-wallet",
    "GET /v1/wallets",
    "POST /v1/wallets",
    "GET /v1/wallets/by-external/{externalId}",
    "GET /v1/wallets/{id}",
    "PATCH /v1/wallets/{id}",
    "POST /v1/wallets/{id}/reconcile",
    "POST /v1/wallets/{id}/dpm-attestation",
    "POST /v1/wallets/{id}/dpm-registered",
    "POST /v1/wallets/{id}/orders/sign",
    "POST /v1/wallets/{id}/orders/cancel",
    "POST /v1/wallets/{id}/allowance",
    "POST /v1/wallets/{id}/redeem",
    "POST /v1/wallets/{id}/split",
    "POST /v1/wallets/{id}/merge",
    "POST /v1/wallets/{id}/withdraw",
    "GET /v1/audit",
    "GET /v1/operations",
    "POST /v1/session/login",
    "POST /v1/session/logout",
    "GET /v1/session/me",
    "POST /v1/session/password",
    "GET /v1/ui-users",
    "POST /v1/ui-users",
    "PATCH /v1/ui-users/{id}",
  ];

  /**
   * The routes without authentication: a probe should not need a credential, and neither can
   * signing in, nor signing out of a session that may already have ended.
   */
  const PUBLIC_ROUTES = ["GET /v1/health", "POST /v1/session/login", "POST /v1/session/logout"];

  /** Public, but answers 401 when the credentials it is given — a username and password — are wrong. */
  const PUBLIC_ROUTES_CHECKING_CREDENTIALS = ["POST /v1/session/login"];

  it("documents every route the app serves, and no others", () => {
    expect(
      operations()
        .map(([route]) => route)
        .sort(),
    ).toEqual([...EXPECTED_ROUTES].sort());
  });

  describe("every operation", () => {
    it("has a stable operationId, unique across the document", () => {
      const ids = operations().map(([, op]) => op.operationId);
      expect(ids.filter((id) => !id)).toHaveLength(0);
      expect(new Set(ids).size).toBe(ids.length);
    });

    it("has a one-line summary", () => {
      for (const [route, op] of operations()) {
        expect(`${route}: ${op.summary ?? ""}`).not.toMatch(/: $/);
        // A summary is a label, not the prose — that belongs in `description`.
        expect(`${route}: ${op.summary}`).not.toContain("\n");
        expect((op.summary ?? "").length).toBeLessThan(60);
      }
    });

    it("has a description explaining what it does", () => {
      for (const [route, op] of operations()) {
        expect(`${route}: ${(op.description ?? "").length > 40}`).toBe(`${route}: true`);
      }
    });

    it("is tagged", () => {
      for (const [route, op] of operations()) {
        expect(`${route}: ${op.tags?.length ?? 0}`).not.toBe(`${route}: 0`);
      }
    });

    it("declares exactly one success response, with a typed body", () => {
      for (const [route, op] of operations()) {
        const success = Object.entries(op.responses).filter(([code]) => code.startsWith("2"));
        expect(`${route}: ${success.length}`).toBe(`${route}: 1`);
        const schema = jsonSchema(success[0]?.[1]);
        expect(`${route}: ${schema ? "typed" : "untyped"}`).toBe(`${route}: typed`);
      }
    });

    it("returns the shared error envelope for every failure it declares", () => {
      for (const [route, op] of operations()) {
        for (const [code, response] of Object.entries(op.responses)) {
          if (code.startsWith("2")) continue;
          const schema = jsonSchema(response);
          expect(`${route} ${code}: ${JSON.stringify(schema)}`).toContain("ErrorResponseDto");
          // A bare status with no explanation is worse than none: it reads as "this can fail"
          // without saying when or what to do.
          expect(
            `${route} ${code}: ${(response as { description?: string }).description ?? ""}`,
          ).toMatch(/`[A-Z_]+`/);
        }
      }
    });

    it("documents every path parameter", () => {
      for (const [route, op] of operations()) {
        for (const parameter of (op.parameters ?? []) as {
          in: string;
          name: string;
          description?: string;
          required?: boolean;
        }[]) {
          if (parameter.in !== "path") continue;
          expect(`${route} ${parameter.name}: ${parameter.description ?? ""}`).not.toMatch(/: $/);
          expect(parameter.required).toBe(true);
        }
      }
    });

    it("names each query parameter without duplicating it", () => {
      for (const [route, op] of operations()) {
        const names = ((op.parameters ?? []) as { name: string; in: string }[]).map(
          (parameter) => `${parameter.in}:${parameter.name}`,
        );
        expect(`${route}: ${names.join(",")}`).toBe(`${route}: ${[...new Set(names)].join(",")}`);
      }
    });
  });

  describe("authentication", () => {
    it("declares the API-key scheme", () => {
      expect(doc.components?.securitySchemes?.apiKey).toEqual({
        type: "apiKey",
        name: "X-API-Key",
        in: "header",
      });
    });

    it("requires it everywhere except the liveness probe", () => {
      for (const [route, op] of operations()) {
        const secured = (op.security ?? []).some((requirement) => "apiKey" in requirement);
        expect(`${route}: ${secured}`).toBe(`${route}: ${!PUBLIC_ROUTES.includes(route)}`);
      }
    });

    it("documents 401 on every authenticated operation, and not on the public ones", () => {
      for (const [route, op] of operations()) {
        const expected =
          !PUBLIC_ROUTES.includes(route) || PUBLIC_ROUTES_CHECKING_CREDENTIALS.includes(route);
        expect(`${route}: ${"401" in op.responses}`).toBe(`${route}: ${expected}`);
      }
    });

    it("documents 403 on every role-restricted operation", () => {
      // These are the routes with a `@Roles(...)`; the decorator adds the response itself, so a
      // route that gains a restriction cannot forget to say so.
      const restricted = operations().filter(
        ([route]) =>
          !PUBLIC_ROUTES.includes(route) &&
          (/^(POST|PATCH|DELETE)/.test(route) ||
            route === "GET /v1/api-keys" ||
            route.startsWith("GET /v1/api-keys/{") ||
            route === "GET /v1/ui-users"),
      );
      for (const [route, op] of restricted) {
        expect(`${route}: ${"403" in op.responses}`).toBe(`${route}: true`);
      }
    });
  });

  describe("request bodies", () => {
    it("are typed wherever one is accepted", () => {
      for (const [route, op] of operations()) {
        if (!op.requestBody) continue;
        expect(`${route}: ${JSON.stringify(jsonSchema(op.requestBody))}`).toContain("$ref");
      }
    });

    it("come with a 400 for validation failures", () => {
      for (const [route, op] of operations()) {
        if (!op.requestBody) continue;
        expect(`${route}: ${"400" in op.responses}`).toBe(`${route}: true`);
      }
    });

    it("advertise the idempotency header on every signing route", () => {
      const signing = operations().filter(([route]) =>
        /(orders\/(sign|cancel)|allowance|redeem|split|merge|withdraw)$/.test(route),
      );
      expect(signing).toHaveLength(7);
      for (const [route, op] of signing) {
        const header = (
          (op.parameters ?? []) as { in: string; name: string; description?: string }[]
        ).find((parameter) => parameter.in === "header");
        expect(`${route}: ${header?.name ?? "none"}`).toBe(`${route}: idempotency-key`);
        expect(header?.description).toContain("IDEMPOTENCY_CONFLICT");
      }
    });
  });

  describe("schemas", () => {
    const schemas = (): [string, SchemaObject][] =>
      Object.entries((doc.components?.schemas ?? {}) as Record<string, SchemaObject>);

    it("document every property with more than a bare type", () => {
      const bare: string[] = [];
      for (const [name, schema] of schemas()) {
        for (const [property, definition] of Object.entries(schema.properties ?? {})) {
          const described = Object.keys(definition).some((key) =>
            [
              "description",
              "example",
              "enum",
              "format",
              "$ref",
              "allOf",
              "items",
              "default",
              "pattern",
            ].includes(key),
          );
          if (!described) bare.push(`${name}.${property}`);
        }
      }
      expect(bare).toEqual([]);
    });

    it("mark required properties", () => {
      // Every request DTO has at least one required field, or the endpoint takes no body at all.
      for (const name of ["SignOrderDto", "SignCancelDto", "MetaTxSplitDto", "CreateApiKeyDto"]) {
        expect(schemaFor(name).required?.length ?? 0).toBeGreaterThan(0);
      }
      // And an optional field is never listed as required.
      expect(schemaFor("CreateWalletDto").required ?? []).toEqual([]);
    });

    it("carry the constraints the validation actually enforces", () => {
      const price = schemaFor("SignOrderDto").properties?.price as SchemaObject;
      // The class-validator shim cannot see through the shared composite decorators, so these are
      // stated explicitly — and `@IsPositive` would otherwise be shimmed to `minimum: 1`, which is
      // wrong for a probability.
      expect(price).toMatchObject({ minimum: 0, exclusiveMinimum: true, maximum: 1 });
      expect(schemaFor("SignCancelDto").properties?.orderHash).toMatchObject({
        pattern: "^0x[0-9a-fA-F]{64}$",
      });
      expect(schemaFor("MetaTxSplitDto").properties?.amountDecimal).toMatchObject({
        pattern: "^\\d+(\\.\\d{1,18})?$",
      });
      // The page window arrives as query parameters rather than a body, so it is not a component
      // schema — the bounds have to be asserted where they actually surface.
      const limit = (
        (doc.paths["/v1/wallets"]?.get?.parameters ?? []) as {
          name: string;
          schema?: SchemaObject;
        }[]
      ).find((parameter) => parameter.name === "limit");
      expect(limit?.schema).toMatchObject({ minimum: 1, maximum: 200, default: 50 });
    });

    it("enumerate every closed set, including the error codes", () => {
      const code = (schemaFor("ErrorBodyDto").properties?.code ?? {}) as SchemaObject;
      expect(code.enum).toContain("EXTERNAL_TRANSFER_FORBIDDEN");
      expect(code.enum).toContain("OPERATIONS_WALLET_REQUIRED");
      expect(schemaFor("CreateApiKeyDto").properties?.role).toMatchObject({
        enum: ["admin", "operator", "readonly"],
      });
      expect(schemaFor("PlatformStatusDto").properties?.mode).toMatchObject({
        enum: ["segregated", "shared"],
      });
      expect((schemaFor("WalletResponseDto").properties?.kind as SchemaObject).enum).toEqual([
        "user",
        "master",
        "operations",
      ]);
    });

    it("explain the routing block, which is the one thing a caller cannot infer", () => {
      const routing = schemaFor("OrderRoutingDto");
      expect(Object.keys(routing.properties ?? {})).toEqual([
        "mode",
        "side",
        "walletId",
        "signerWalletId",
        "maker",
        "recipient",
      ]);
      expect((routing.properties?.signerWalletId as SchemaObject).description).toMatch(
        /shared mode/,
      );
    });

    function schemaFor(name: string): SchemaObject {
      const schema = (doc.components?.schemas ?? {})[name] as SchemaObject | undefined;
      if (!schema) throw new Error(`no schema named ${name}`);
      return schema;
    }
  });

  it("describes the service, so the schema stands alone", () => {
    expect(doc.info.description).toMatch(/Sign-only/);
    expect(doc.info.description).toMatch(/X-API-Key/);
    expect(doc.tags?.map((tag) => tag.name)).toEqual(
      expect.arrayContaining(["platform", "wallets", "orders", "meta-tx", "api-keys", "audit"]),
    );
    for (const tag of doc.tags ?? []) expect(tag.description).toBeTruthy();
  });
});

/** The JSON schema out of a response or request-body object, whatever its wrapping. */
function jsonSchema(container: unknown): unknown {
  const content = (container as { content?: Record<string, { schema?: unknown }> })?.content;
  return content?.["application/json"]?.schema;
}
