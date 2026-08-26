import { FakeDpmWallet } from "../src/testing/fake-dpm-wallet";
import { startHarness, type Harness } from "../src/testing/harness";

/**
 * Mode burn-in and the two platform wallets.
 *
 * The mode is the one value in this service that cannot be corrected after the fact, so the tests
 * that matter most here are the ones about what happens when the environment and the database
 * disagree.
 */
describe("platform", () => {
  describe("status", () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness();
    });

    afterAll(async () => {
      await harness.close();
    });

    it("reports the burned mode and reaches the upstream", async () => {
      const response = await harness.get("/v1/platform");
      expect(response.status).toBe(200);
      expect(response.body.mode).toBe("segregated");
      expect(response.body.modeBurnedAt).toMatch(/^\d{4}-/);
      expect(response.body.masterWallet).toBeNull();
      expect(response.body.upstream).toEqual({
        reachable: true,
        vault: { initialized: true, ready: true },
      });
    });

    it("is readable by an operator, who has to know which mode they are trading in", async () => {
      const response = await harness.get("/v1/platform", { apiKey: harness.operatorKey });
      expect(response.status).toBe(200);
    });

    it("reports an unreachable upstream instead of failing", async () => {
      harness.upstream.failNextWith(503, "INTERNAL_ERROR");
      const response = await harness.get("/v1/platform");
      expect(response.status).toBe(200);
      expect(response.body.upstream.reachable).toBe(false);
    });

    it("shows a vault that is not initialised", async () => {
      harness.upstream.vaultInitialized = false;
      const response = await harness.get("/v1/platform");
      expect(response.body.upstream.vault).toEqual({ initialized: false, ready: true });
      harness.upstream.vaultInitialized = true;
    });
  });

  describe("platform wallets", () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
    });

    afterAll(async () => {
      await harness.close();
    });

    it("creates the master wallet with an admin key only", async () => {
      const refused = await harness.post("/v1/platform/master-wallet", {
        body: {},
        apiKey: harness.operatorKey,
      });
      expect(refused.status).toBe(403);

      const created = await harness.post("/v1/platform/master-wallet", { body: {} });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ kind: "master", status: "active" });
      expect(created.body.address).toMatch(/^0x/);
    });

    it("creates the operations wallet with an operator key", async () => {
      const created = await harness.post("/v1/platform/operations-wallet", {
        body: {},
        apiKey: harness.operatorKey,
      });
      expect(created.status).toBe(200);
      expect(created.body).toMatchObject({ kind: "operations", status: "active" });
      expect(created.body.note).toBeUndefined();
    });

    it("returns the existing wallet rather than refusing a second call", async () => {
      const first = await harness.get("/v1/platform");
      const again = await harness.post("/v1/platform/master-wallet", { body: {} });
      expect(again.status).toBe(200);
      expect(again.body.id).toBe(first.body.masterWallet.id);
    });

    it("never creates two, even when called concurrently", async () => {
      const responses = await Promise.all([
        harness.post("/v1/platform/operations-wallet", { body: {} }),
        harness.post("/v1/platform/operations-wallet", { body: {} }),
        harness.post("/v1/platform/operations-wallet", { body: {} }),
      ]);
      const ids = new Set(responses.map((response) => response.body.id));
      expect(responses.every((response) => response.status === 200)).toBe(true);
      expect(ids.size).toBe(1);
      expect((await harness.wallets.list({ kind: "operations" }, 10, 0)).total).toBe(1);
    });

    it("surfaces both on the status endpoint", async () => {
      const status = await harness.get("/v1/platform");
      expect(status.body.masterWallet.kind).toBe("master");
      expect(status.body.operationsWallet.kind).toBe("operations");
      expect(status.body.walletCount).toBe(2);
    });
  });

  describe("in segregated mode", () => {
    let harness: Harness;

    beforeAll(async () => {
      harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "segregated" });
    });

    afterAll(async () => {
      await harness.close();
    });

    it("still allows an operations wallet, but says it is unused", async () => {
      const created = await harness.post("/v1/platform/operations-wallet", { body: {} });
      expect(created.status).toBe(200);
      expect(created.body.note).toMatch(/segregated/);
    });
  });

  describe("mode burn-in", () => {
    it("survives a restart against the same database", async () => {
      const first = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      const databaseUrl = (first.db.options as { url: string }).url;
      const burnedAt = (await first.get("/v1/platform")).body.modeBurnedAt;
      await first.stop();

      const second = await startHarness({
        DATABASE_URL: databaseUrl,
        DPM_WALLET_MANAGER_MODE: "shared",
      });
      try {
        const status = await second.get("/v1/platform");
        expect(status.body.mode).toBe("shared");
        // The same burn, not a new one.
        expect(status.body.modeBurnedAt).toBe(burnedAt);
      } finally {
        await second.stop();
        await first.close();
      }
    });

    it("refuses to start when the environment disagrees with the burned value", async () => {
      const first = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      const databaseUrl = (first.db.options as { url: string }).url;
      await first.stop();

      await expect(
        startHarness({ DATABASE_URL: databaseUrl, DPM_WALLET_MANAGER_MODE: "segregated" }),
      ).rejects.toThrow(/PLATFORM_MODE_MISMATCH/);

      // And the burned value is untouched, so correcting the environment recovers the install.
      const recovered = await startHarness({
        DATABASE_URL: databaseUrl,
        DPM_WALLET_MANAGER_MODE: "shared",
      });
      try {
        expect((await recovered.get("/v1/platform")).body.mode).toBe("shared");
      } finally {
        await recovered.stop();
        await first.close();
      }
    });

    it("refuses to start on a mode nobody recognises", async () => {
      const first = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      const databaseUrl = (first.db.options as { url: string }).url;
      await first.db.query("UPDATE platform_settings SET value = 'pooled' WHERE key = 'mode'");
      await first.stop();

      await expect(
        startHarness({ DATABASE_URL: databaseUrl, DPM_WALLET_MANAGER_MODE: "shared" }),
      ).rejects.toThrow(/not one of/);
      await first.close();
    });

    it("rejects an unknown mode in the environment before it reaches the database", async () => {
      await expect(startHarness({ DPM_WALLET_MANAGER_MODE: "pooled" })).rejects.toThrow(
        /DPM_WALLET_MANAGER_MODE must be one of/,
      );
    });

    it("cannot be changed through the settings repository either", async () => {
      const harness = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" });
      try {
        await expect(
          harness.settings.set("mode", "segregated", new Date().toISOString()),
        ).rejects.toThrow(/write-once/);
        expect(await harness.settings.get("mode")).toBe("shared");
      } finally {
        await harness.close();
      }
    });

    it("lets one boot win when two race on an empty database", async () => {
      const upstream = new FakeDpmWallet();
      await upstream.start();
      const seed = await startHarness({ DPM_WALLET_MANAGER_MODE: "shared" }, { upstream });
      const databaseUrl = (seed.db.options as { url: string }).url;
      await seed.db.query("DELETE FROM platform_settings");
      await seed.stop();

      // Two containers booting at the same instant against one empty database.
      const [a, b] = await Promise.all([
        startHarness(
          { DATABASE_URL: databaseUrl, DPM_WALLET_MANAGER_MODE: "shared" },
          { upstream },
        ),
        startHarness(
          { DATABASE_URL: databaseUrl, DPM_WALLET_MANAGER_MODE: "shared" },
          { upstream },
        ),
      ]);
      try {
        expect((await a.get("/v1/platform")).body.mode).toBe("shared");
        expect((await b.get("/v1/platform")).body.mode).toBe("shared");
        const rows = await a.db.query<{ count: string }[]>(
          "SELECT count(*)::text AS count FROM platform_settings WHERE key = 'mode'",
        );
        expect(rows[0]?.count).toBe("1");
      } finally {
        await a.stop();
        await b.stop();
        await seed.close();
        await upstream.stop();
      }
    });
  });
});
