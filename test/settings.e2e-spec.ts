import { startHarness, type Harness } from "../src/testing/harness";

const PASSWORD = "correct horse battery";
const ADMIN_UI_HEADERS = { "X-Requested-With": "dpmm-admin" };

/** The dashboard settings API: who may change them, and what a change does and audits. */
describe("settings", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness.close();
  });

  const audited = async (action: string) =>
    (await harness.get("/v1/audit", { query: { action, limit: 100 } })).body.items as {
      detail: any;
    }[];

  describe("retention", () => {
    it("lets any role read, with the fixed values, and refuses a non-admin write", async () => {
      for (const apiKey of [harness.readonlyKey, harness.operatorKey, harness.adminKey]) {
        const response = await harness.get("/v1/settings/retention", { apiKey });
        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({
          enabled: expect.any(Boolean),
          routineDays: 90,
          routedOrderDays: 365,
          archiveReminderDays: 730,
          sources: { routineDays: "environment", archiveReminderDays: "default" },
          defaults: { routineDays: 90, routedOrderDays: 365, archiveReminderDays: 730 },
          fixed: { idempotencyHours: 24, logs: "5 × 20 MB per service" },
        });
      }
      for (const apiKey of [harness.readonlyKey, harness.operatorKey]) {
        const denied = await harness.put("/v1/settings/retention", {
          apiKey,
          body: { routineDays: 30 },
        });
        expect(denied.status).toBe(403);
      }
    });

    it("treats a viewer session as read-only and an owner session as admin", async () => {
      for (const [username, role] of [
        ["settings-viewer", "viewer"],
        ["settings-owner", "owner"],
      ]) {
        const created = await harness.post("/v1/ui-users", {
          body: { username, password: PASSWORD, role },
        });
        expect(created.status).toBe(201);
      }
      const cookieFor = async (username: string) => {
        const login = await harness.post("/v1/session/login", {
          apiKey: null,
          body: { username, password: PASSWORD },
        });
        const line = (login.headers["set-cookie"] as string[]).find((h) =>
          h.startsWith("dpmm_session="),
        );
        return (line as string).split(";")[0] as string;
      };
      const viewer = await cookieFor("settings-viewer");
      const owner = await cookieFor("settings-owner");
      expect((await harness.get("/v1/settings/storage", { cookie: viewer })).status).toBe(200);
      const denied = await harness.put("/v1/settings/storage", {
        cookie: viewer,
        headers: ADMIN_UI_HEADERS,
        body: { warningDays: 40 },
      });
      expect(denied.status).toBe(403);
      const ok = await harness.put("/v1/settings/storage", {
        cookie: owner,
        headers: ADMIN_UI_HEADERS,
        body: { warningDays: 40 },
      });
      expect(ok.status).toBe(200);
      await harness.put("/v1/settings/storage", { body: { warningDays: null } });
    });

    it("persists an admin change, marks it dashboard, and null reverts it", async () => {
      const put = await harness.put("/v1/settings/retention", { body: { routineDays: 30 } });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        routineDays: 30,
        sources: { routineDays: "dashboard", routedOrderDays: "environment" },
      });
      const read = await harness.get("/v1/settings/retention");
      expect(read.body.routineDays).toBe(30);

      const events = await audited("settings.retention_update");
      expect(events[0]?.detail).toMatchObject({
        before: { routineDays: 90 },
        after: { routineDays: 30 },
      });

      const revert = await harness.put("/v1/settings/retention", { body: { routineDays: null } });
      expect(revert.body).toMatchObject({
        routineDays: 90,
        sources: { routineDays: "environment" },
      });
      expect((await audited("settings.retention_update")).length).toBe(events.length + 1);
    });

    it("rejects a bound violation with 400 and changes nothing", async () => {
      for (const body of [
        { routineDays: 0 },
        { routineDays: 4000 },
        { routedOrderDays: 10 },
        { routineDays: 1.5 },
        { enabled: "yes" },
      ]) {
        const response = await harness.put("/v1/settings/retention", { body });
        expect(`${JSON.stringify(body)}: ${response.status}`).toBe(`${JSON.stringify(body)}: 400`);
        expect(response.body.error.code).toBe("VALIDATION_FAILED");
      }
      const read = await harness.get("/v1/settings/retention");
      expect(read.body).toMatchObject({ routineDays: 90, routedOrderDays: 365 });
    });
  });

  describe("storage", () => {
    it("reports the defaults with their sources", async () => {
      const response = await harness.get("/v1/settings/storage", { apiKey: harness.readonlyKey });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        warningPercent: 75,
        warningDays: 30,
        criticalPercent: 90,
        criticalDays: 7,
        alertWebhookUrl: null,
        alertWebhookConfigured: false,
        sources: {
          warningPercent: "default",
          warningDays: "default",
          criticalPercent: "default",
          criticalDays: "default",
          alertWebhookUrl: "default",
        },
      });
    });

    it("refuses a non-admin write", async () => {
      const denied = await harness.put("/v1/settings/storage", {
        apiKey: harness.operatorKey,
        body: { warningPercent: 60 },
      });
      expect(denied.status).toBe(403);
    });

    it("persists a change, audits old and new values once, and null reverts", async () => {
      const before = (await audited("settings.storage_update")).length;
      const put = await harness.put("/v1/settings/storage", {
        body: { warningPercent: 60, alertWebhookUrl: "https://hooks.example.com/secret/abc" },
      });
      expect(put.status).toBe(200);
      expect(put.body).toMatchObject({
        warningPercent: 60,
        alertWebhookUrl: "https://hooks.example.com/secret/abc",
        sources: {
          warningPercent: "dashboard",
          alertWebhookUrl: "dashboard",
          warningDays: "default",
        },
      });
      const events = await audited("settings.storage_update");
      expect(events.length).toBe(before + 1);
      expect(events[0]?.detail).toMatchObject({
        before: { warningPercent: 75, alertWebhookUrl: null },
        after: { warningPercent: 60, alertWebhookUrl: "https://hooks.example.com/…" },
      });
      expect(JSON.stringify(events[0]?.detail)).not.toContain("secret");

      const revert = await harness.put("/v1/settings/storage", {
        body: { warningPercent: null, alertWebhookUrl: null },
      });
      expect(revert.body).toMatchObject({ warningPercent: 75, alertWebhookUrl: null });
      expect(revert.body.sources.warningPercent).toBe("default");
      expect((await audited("settings.storage_update")).length).toBe(before + 2);
    });

    it("shows the full webhook URL to admins only, masked and flagged to everyone else", async () => {
      await harness.put("/v1/settings/storage", {
        body: { alertWebhookUrl: "https://hooks.example/secret-token" },
      });
      const login = async (username: string, role: string) => {
        await harness.post("/v1/ui-users", { body: { username, password: PASSWORD, role } });
        const res = await harness.post("/v1/session/login", {
          apiKey: null,
          body: { username, password: PASSWORD },
        });
        const line = (res.headers["set-cookie"] as string[]).find((h) =>
          h.startsWith("dpmm_session="),
        );
        return (line as string).split(";")[0] as string;
      };
      const viewer = await login("hook-viewer", "viewer");
      const operatorUser = await login("hook-operator", "operator");
      const owner = await login("hook-owner", "owner");

      const admin = await harness.get("/v1/settings/storage");
      expect(admin.body).toMatchObject({
        alertWebhookUrl: "https://hooks.example/secret-token",
        alertWebhookConfigured: true,
      });
      expect(
        (await harness.get("/v1/settings/storage", { cookie: owner })).body.alertWebhookUrl,
      ).toBe("https://hooks.example/secret-token");

      const others = [
        await harness.get("/v1/settings/storage", { apiKey: harness.readonlyKey }),
        await harness.get("/v1/settings/storage", { apiKey: harness.operatorKey }),
        await harness.get("/v1/settings/storage", { cookie: viewer }),
        await harness.get("/v1/settings/storage", { cookie: operatorUser }),
      ];
      for (const response of others) {
        expect(JSON.stringify(response.body)).not.toContain("secret-token");
        expect(response.body).toMatchObject({
          alertWebhookUrl: "https://hooks.example/…",
          alertWebhookConfigured: true,
        });
      }
      await harness.put("/v1/settings/storage", { body: { alertWebhookUrl: null } });
      const none = await harness.get("/v1/settings/storage", { apiKey: harness.readonlyKey });
      expect(none.body).toMatchObject({ alertWebhookUrl: null, alertWebhookConfigured: false });
    });

    it("rejects each bound violation with 400, judged against the values after the patch", async () => {
      for (const body of [
        { warningPercent: 0 },
        { criticalPercent: 100 },
        { warningPercent: 95 },
        { criticalPercent: 70 },
        { warningDays: 366 },
        { criticalDays: 0 },
        { warningDays: 5 },
        { criticalDays: 30 },
        { alertWebhookUrl: "ftp://example.com/x" },
        { alertWebhookUrl: "not a url" },
        { alertWebhookUrl: "" },
        { warningPercent: 50.5 },
      ]) {
        const response = await harness.put("/v1/settings/storage", { body });
        expect(`${JSON.stringify(body)}: ${response.status}`).toBe(`${JSON.stringify(body)}: 400`);
        expect(response.body.error.code).toBe("VALIDATION_FAILED");
      }
      // Moving both ends together is fine even though each alone would break the order.
      const both = await harness.put("/v1/settings/storage", {
        body: { warningPercent: 92, criticalPercent: 97 },
      });
      expect(both.status).toBe(200);
      await harness.put("/v1/settings/storage", {
        body: { warningPercent: null, criticalPercent: null },
      });
    });
  });
});
