import { startHarness, type Harness } from "../src/testing/harness";

/**
 * The credential lifecycle end to end, through the real guards. What is being pinned here is not
 * that the endpoints respond, but that the three properties the design rests on hold: a key is
 * never stored in plaintext, a rotation leaves an overlap rather than a gap, and the install
 * cannot be locked out of its own administration.
 */
describe("api keys", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const createOperator = async (name = "trading-backend") => {
    const response = await harness.post("/v1/api-keys", {
      body: { role: "operator", name },
    });
    expect(response.status).toBe(201);
    return response.body;
  };

  describe("authentication", () => {
    it("refuses a request with no key", async () => {
      const response = await harness.get("/v1/api-keys", { apiKey: null });
      expect(response.status).toBe(401);
      expect(response.body.error.code).toBe("UNAUTHORIZED");
    });

    it("gives the same answer to a malformed key, an unknown key and a wrong secret", async () => {
      const admin = await harness.get("/v1/api-keys/self");
      const realPrefix = admin.body.prefix as string;
      const wrongSecret = `${realPrefix}${"z".repeat(24)}`;

      const responses = await Promise.all([
        harness.get("/v1/api-keys", { apiKey: "garbage" }),
        harness.get("/v1/api-keys", { apiKey: "dpmm_test_ad_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }),
        harness.get("/v1/api-keys", { apiKey: wrongSecret }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
        expect(response.body.error).toEqual({
          code: "UNAUTHORIZED",
          message: "Missing or invalid API key",
        });
      }
    });

    it("leaves health public", async () => {
      const response = await harness.get("/v1/health", { apiKey: null });
      expect(response.status).toBe(200);
    });

    it("identifies the calling key through self, for either role", async () => {
      const admin = await harness.get("/v1/api-keys/self");
      expect(admin.body).toMatchObject({ role: "admin", name: "harness-admin" });
      expect(admin.body.prefix).toMatch(/^dpmm_test_ad_/);

      const operator = await harness.get("/v1/api-keys/self", { apiKey: harness.operatorKey });
      expect(operator.body).toMatchObject({ role: "operator" });
    });

    it("records the key's last use", async () => {
      const before = await harness.get("/v1/api-keys/self", { apiKey: harness.operatorKey });
      const stored = await harness.keys.findById(before.body.keyId as string);
      expect(stored?.lastUsedAt).not.toBeNull();
    });
  });

  describe("role enforcement", () => {
    it("refuses an operator key on an admin route", async () => {
      const response = await harness.get("/v1/api-keys", { apiKey: harness.operatorKey });
      expect(response.status).toBe(403);
      expect(response.body.error.code).toBe("FORBIDDEN");
      expect(response.body.error.details).toMatchObject({ actorRole: "operator" });
    });

    it("admits an admin key wherever an operator key would be admitted", async () => {
      // `self` is the operator-reachable route on this controller; an admin must not be refused.
      const response = await harness.get("/v1/api-keys/self", { apiKey: harness.adminKey });
      expect(response.status).toBe(200);
    });
  });

  describe("creation", () => {
    it("returns the plaintext once and never again", async () => {
      const created = await createOperator();
      expect(created.key).toMatch(/^dpmm_test_op_[a-z0-9]{32}$/);
      expect(created.key.startsWith(created.prefix)).toBe(true);

      const listed = await harness.get("/v1/api-keys");
      const found = listed.body.items.find((item: { id: string }) => item.id === created.id);
      expect(found).toBeDefined();
      expect(found.key).toBeUndefined();
      expect(found.hash).toBeUndefined();
      expect(found.secretEncrypted).toBeUndefined();
    });

    it("stores neither the key nor anything that yields it without the master key", async () => {
      const created = await createOperator("no-plaintext");
      const stored = await harness.keys.findById(created.id);
      expect(stored?.hash).not.toContain(created.key);
      expect(stored?.secretEncrypted).not.toContain(created.key);
      expect(stored?.secretEncrypted).toMatch(/^v1\./);
    });

    it("the minted key actually authenticates", async () => {
      const created = await createOperator("usable");
      const response = await harness.get("/v1/api-keys/self", { apiKey: created.key });
      expect(response.status).toBe(200);
      expect(response.body.keyId).toBe(created.id);
    });

    it("rejects an unknown role", async () => {
      const response = await harness.post("/v1/api-keys", { body: { role: "root", name: "x" } });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe("VALIDATION_FAILED");
    });
  });

  describe("reveal", () => {
    it("returns the same key that was minted", async () => {
      const created = await createOperator("revealable");
      const revealed = await harness.post(`/v1/api-keys/${created.id}/reveal`);
      expect(revealed.status).toBe(200);
      expect(revealed.body.key).toBe(created.key);
    });

    it("is admin-only", async () => {
      const created = await createOperator("reveal-guard");
      const response = await harness.post(`/v1/api-keys/${created.id}/reveal`, {
        apiKey: harness.operatorKey,
      });
      expect(response.status).toBe(403);
    });

    it("writes an audit row naming the key that asked", async () => {
      const created = await createOperator("reveal-audit");
      await harness.post(`/v1/api-keys/${created.id}/reveal`);
      const page = await harness.auditRepo.query({ action: "key.reveal" }, 10, 0);
      const event = page.events.find((e) => e.detail?.keyId === created.id);
      expect(event).toBeDefined();
      expect(event?.actorRole).toBe("admin");
    });

    it("throttles repeated reveals of one key", async () => {
      const created = await createOperator("reveal-throttle");
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        statuses.push((await harness.post(`/v1/api-keys/${created.id}/reveal`)).status);
      }
      expect(statuses.filter((status) => status === 200)).toHaveLength(5);
      expect(statuses.filter((status) => status === 429)).toHaveLength(2);
    });

    it("404s an unknown id, and 400s one that is not an id at all", async () => {
      expect(
        (await harness.post("/v1/api-keys/00000000-0000-4000-8000-000000000000/reveal")).status,
      ).toBe(404);
      expect((await harness.post("/v1/api-keys/not-a-uuid/reveal")).status).toBe(400);
    });
  });

  describe("rotation", () => {
    it("leaves both keys usable during the grace window", async () => {
      const original = await createOperator("rotating");
      const rotation = await harness.post(`/v1/api-keys/${original.id}/rotate`, {
        body: { graceSeconds: 3600 },
      });
      expect(rotation.status).toBe(200);

      const replacement = rotation.body.created;
      expect(replacement.role).toBe("operator");
      expect(replacement.rotatedFromId).toBe(original.id);
      expect(rotation.body.rotated.expiresAt).not.toBeNull();

      // The whole point: nothing has to swap credentials at the same instant.
      expect((await harness.get("/v1/api-keys/self", { apiKey: original.key })).status).toBe(200);
      expect((await harness.get("/v1/api-keys/self", { apiKey: replacement.key })).status).toBe(
        200,
      );
    });

    it("kills the old key immediately when the grace is zero, as a leak response", async () => {
      const original = await createOperator("leaked");
      const rotation = await harness.post(`/v1/api-keys/${original.id}/rotate`, {
        body: { graceSeconds: 0 },
      });
      expect(rotation.body.rotated.status).toBe("revoked");
      expect((await harness.get("/v1/api-keys/self", { apiKey: original.key })).status).toBe(401);
      expect(
        (await harness.get("/v1/api-keys/self", { apiKey: rotation.body.created.key })).status,
      ).toBe(200);
    });

    it("refuses to rotate a revoked key", async () => {
      const original = await createOperator("already-gone");
      await harness.del(`/v1/api-keys/${original.id}`);
      const response = await harness.post(`/v1/api-keys/${original.id}/rotate`, { body: {} });
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("API_KEY_REVOKED");
    });

    it("rejects a grace window longer than a month", async () => {
      const original = await createOperator("too-long");
      const response = await harness.post(`/v1/api-keys/${original.id}/rotate`, {
        body: { graceSeconds: 60 * 60 * 24 * 400 },
      });
      expect(response.status).toBe(400);
    });
  });

  describe("revocation", () => {
    it("stops the key working", async () => {
      const created = await createOperator("doomed");
      expect((await harness.del(`/v1/api-keys/${created.id}`)).status).toBe(200);
      expect((await harness.get("/v1/api-keys/self", { apiKey: created.key })).status).toBe(401);
    });

    it("is idempotent", async () => {
      const created = await createOperator("doomed-twice");
      await harness.del(`/v1/api-keys/${created.id}`);
      const second = await harness.del(`/v1/api-keys/${created.id}`);
      expect(second.status).toBe(200);
      expect(second.body.status).toBe("revoked");
    });

    it("refuses to revoke the last usable admin key", async () => {
      const self = await harness.get("/v1/api-keys/self");
      const response = await harness.del(`/v1/api-keys/${self.body.keyId}`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("LAST_ADMIN_KEY");
      // And the key still works, which is the property that matters.
      expect((await harness.get("/v1/api-keys/self")).status).toBe(200);
    });

    it("allows revoking an admin key once another usable one exists", async () => {
      const spare = await harness.post("/v1/api-keys", {
        body: { role: "admin", name: "spare-admin" },
      });
      const self = await harness.get("/v1/api-keys/self");
      const response = await harness.del(`/v1/api-keys/${self.body.keyId}`, {
        apiKey: spare.body.key,
      });
      expect(response.status).toBe(200);
      // Restore the harness's default credential for any later test in this file.
      harness.adminKey = spare.body.key;
    });
  });
});

describe("api keys on an empty install", () => {
  it("says how to mint the first key rather than a bare 401", async () => {
    const harness = await startHarness({}, { withoutKeys: true });
    try {
      const response = await harness.get("/v1/api-keys", {
        apiKey: "dpmm_test_ad_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      expect(response.status).toBe(401);
      expect(response.body.error.message).toMatch(/keys:bootstrap/);
    } finally {
      await harness.close();
    }
  });

  it("adopts a configured bootstrap key, and never re-seeds afterwards", async () => {
    const configured = "dpmm_test_ad_k7m2q9x4b3n8v3c6z2s5t2r7w4y9p8j3";
    const harness = await startHarness(
      { DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY: configured },
      { withoutKeys: true },
    );
    try {
      const service = harness.app.get(
        (await import("../src/api-keys/api-key.service")).ApiKeyService,
      );
      const first = await service.bootstrap();
      expect(first.created).toBe(true);
      expect(first.key.key).toBe(configured);
      expect((await harness.get("/v1/api-keys", { apiKey: configured })).status).toBe(200);

      // A second call must not mint a second admin credential.
      const second = await service.bootstrap();
      expect(second.created).toBe(false);
    } finally {
      await harness.close();
    }
  });
});
