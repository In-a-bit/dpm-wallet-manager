import { randomUUID } from "node:crypto";

import { startDbFixture, type DbFixture } from "../../testing/db-fixture";
import { ApiKeyRepository } from "./api-key.repo";
import { AuditRepository } from "./audit.repo";
import { IdempotencyRepository } from "./idempotency.repo";
import { OperationRepository } from "./operation.repo";
import { PlatformSettingsRepository } from "./platform-settings.repo";
import { WalletRepository } from "./wallet.repo";

/**
 * Against a real, migrated Postgres rather than a mock: the guarantees that matter here are the
 * hand-written indexes from the migration, and a fake would assert nothing about them.
 */
describe("repositories", () => {
  let fixture: DbFixture;
  let wallets: WalletRepository;
  let settings: PlatformSettingsRepository;
  let keys: ApiKeyRepository;
  let audit: AuditRepository;
  let operations: OperationRepository;
  let idempotency: IdempotencyRepository;

  const now = () => new Date().toISOString();

  beforeAll(async () => {
    fixture = await startDbFixture();
    const db = fixture.db;
    wallets = new WalletRepository(db);
    settings = new PlatformSettingsRepository(db);
    keys = new ApiKeyRepository(db);
    audit = new AuditRepository(db);
    operations = new OperationRepository(db);
    idempotency = new IdempotencyRepository(db);
  });

  afterAll(async () => {
    await fixture.close();
  });

  const newWallet = (over: Partial<Parameters<WalletRepository["insertProvisioning"]>[0]> = {}) => {
    const id = randomUUID();
    return {
      id,
      ref: `mgr:${id}`,
      kind: "user" as const,
      externalId: null,
      label: null,
      createdAt: now(),
      ...over,
    };
  };

  describe("platform settings", () => {
    it("burns a value once and reports the stored one on every later attempt", async () => {
      expect(await settings.burnOnce("mode", "shared", now())).toBe("shared");
      // The second call is the second container booting with a different env: it must read the
      // burned value rather than overwrite it.
      expect(await settings.burnOnce("mode", "segregated", now())).toBe("shared");
      expect(await settings.get("mode")).toBe("shared");
    });

    it("refuses to update a write-once key through the ordinary setter", async () => {
      await expect(settings.set("mode", "segregated", now())).rejects.toThrow(/write-once/);
    });

    it("upserts an ordinary setting", async () => {
      await settings.set("ui.banner", "hello", now());
      await settings.set("ui.banner", "goodbye", now());
      expect(await settings.get("ui.banner")).toBe("goodbye");
      expect(await settings.all()).toMatchObject({ mode: "shared", "ui.banner": "goodbye" });
    });
  });

  describe("wallets", () => {
    it("provisions in two steps, and is not ready in between", async () => {
      const created = await wallets.insertProvisioning(newWallet());
      expect(created.status).toBe("provisioning");
      expect(created.eoaAddress).toBeNull();

      const ready = await wallets.markProvisioned(
        created.id,
        {
          // Deliberately lowercase: the repository is the one place addresses are canonicalised.
          eoaAddress: "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
          proxyAddress: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045",
          derivationIndex: 0,
          dpmRegistered: false,
        },
        now(),
      );
      expect(ready?.status).toBe("active");
      expect(ready?.eoaAddress).toBe("0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174");
      expect(ready?.proxyAddress).toBe("0x4D97DCd97eC945f40cF65F87097ACe5EA0476045");
    });

    it("recognises a platform address whatever its casing, and on either column", async () => {
      expect(await wallets.isPlatformAddress("0x2791BCA1F2DE4661ED88A30C99A7A9449AA84174")).toBe(
        true,
      );
      expect(await wallets.isPlatformAddress("0x4d97dcd97ec945f40cf65f87097ace5ea0476045")).toBe(
        true,
      );
      expect(await wallets.isPlatformAddress("0x000000000000000000000000000000000000dEaD")).toBe(
        false,
      );
    });

    it("allows only one master wallet, in the database rather than the service", async () => {
      await wallets.insertProvisioning(newWallet({ kind: "master" }));
      await expect(wallets.insertProvisioning(newWallet({ kind: "master" }))).rejects.toThrow();
    });

    it("allows only one operations wallet", async () => {
      await wallets.insertProvisioning(newWallet({ kind: "operations" }));
      await expect(wallets.insertProvisioning(newWallet({ kind: "operations" }))).rejects.toThrow();
    });

    it("treats external ids case-insensitively, so one customer cannot become two wallets", async () => {
      await wallets.insertProvisioning(newWallet({ externalId: "Cust-1" }));
      await expect(
        wallets.insertProvisioning(newWallet({ externalId: "cust-1" })),
      ).rejects.toThrow();
      expect((await wallets.findByExternalId("CUST-1"))?.externalId).toBe("Cust-1");
    });

    it("filters and pages", async () => {
      const page = await wallets.list({ kind: "user" }, 2, 0);
      expect(page.wallets).toHaveLength(2);
      expect(page.total).toBeGreaterThanOrEqual(2);
      expect(page.wallets.every((wallet) => wallet.kind === "user")).toBe(true);
    });

    it("lists the rows a crashed provisioning left behind", async () => {
      const stuck = await wallets.insertProvisioning(newWallet());
      const ids = (await wallets.listProvisioning()).map((wallet) => wallet.id);
      expect(ids).toContain(stuck.id);
    });
  });

  describe("api keys", () => {
    const key = (over: Record<string, unknown> = {}) => ({
      id: randomUUID(),
      role: "admin" as const,
      name: "test",
      prefix: `dpmm_test_ad${randomUUID().slice(0, 2)}`,
      hash: "deadbeef",
      secretEncrypted: "v1.a.b.c",
      expiresAt: null,
      rotatedFromId: null,
      createdByKeyId: null,
      createdByUserId: null,
      createdAt: now(),
      ...over,
    });

    it("counts only keys that could authenticate a request right now", async () => {
      const past = new Date(Date.now() - 60_000).toISOString();
      const future = new Date(Date.now() + 60_000).toISOString();
      await keys.insert(key({ prefix: "dpmm_test_ad01" }));
      await keys.insert(key({ prefix: "dpmm_test_ad02", expiresAt: future }));
      await keys.insert(key({ prefix: "dpmm_test_ad03", expiresAt: past }));
      const revoked = await keys.insert(key({ prefix: "dpmm_test_ad04" }));
      await keys.revoke(revoked.id, now());

      expect(await keys.countUsable("admin", now())).toBe(2);
    });

    it("rejects a duplicate prefix", async () => {
      await keys.insert(key({ prefix: "dpmm_test_op01", role: "operator" }));
      await expect(keys.insert(key({ prefix: "dpmm_test_op01" }))).rejects.toThrow();
    });
  });

  describe("audit and operations", () => {
    it("round-trips a detail object and filters by action", async () => {
      const walletId = randomUUID();
      await audit.insert({
        actorKeyId: null,
        actorRole: "admin",
        actorUserId: null,
        actorUsername: null,
        walletId,
        action: "meta.withdraw.external",
        outcome: "success",
        detail: { recipient: "0xdead", amountDecimal: "10" },
        requestId: null,
        ip: null,
        createdAt: now(),
      });
      const page = await audit.query({ action: "meta.withdraw.external" }, 10, 0);
      expect(page.total).toBe(1);
      expect(page.events[0]?.detail).toEqual({ recipient: "0xdead", amountDecimal: "10" });
    });

    it("records an operation and finds it by wallet", async () => {
      const walletId = randomUUID();
      await operations.insert({
        id: randomUUID(),
        walletId,
        signerWalletId: walletId,
        kind: "order",
        mode: "segregated",
        requestHash: "abc",
        resultSummary: "0xhash",
        status: "signed",
        apiKeyId: null,
        uiUserId: null,
        createdAt: now(),
      });
      expect((await operations.query({ walletId }, 10, 0)).total).toBe(1);
    });
  });

  describe("idempotency", () => {
    it("keeps the first writer's record when two retries race", async () => {
      await idempotency.save("k1", { requestHash: "h1", responseJson: '{"a":1}' }, now());
      await idempotency.save("k1", { requestHash: "h2", responseJson: '{"b":2}' }, now());
      expect(await idempotency.find("k1")).toEqual({
        requestHash: "h1",
        responseJson: '{"a":1}',
      });
    });

    it("purges only records older than the retention window", async () => {
      const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      await idempotency.save("k-old", { requestHash: "h", responseJson: "{}" }, old);
      expect(await idempotency.purgeExpired()).toBe(1);
      expect(await idempotency.find("k-old")).toBeUndefined();
      expect(await idempotency.find("k1")).toBeDefined();
    });
  });
});
