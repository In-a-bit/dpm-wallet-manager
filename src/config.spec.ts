import { insecureCookieWarning, loadConfig } from "./config";
import { testEnv } from "./testing/env";

function load(extra: Record<string, string> = {}) {
  return loadConfig(testEnv({ DATABASE_URL: "postgres://unused/unused", ...extra }));
}

describe("loadConfig retention defaults", () => {
  it("defaults to enabled, 90 days routine, 365 days routed", () => {
    expect(load().retentionDefaults).toEqual({
      enabled: true,
      routineDays: 90,
      routedOrderDays: 365,
    });
  });

  it("reads the environment", () => {
    expect(
      load({
        RETENTION_ENABLED: "false",
        OPERATIONS_RETENTION_DAYS: "30",
        ROUTED_ORDER_RETENTION_DAYS: "3650",
      }).retentionDefaults,
    ).toEqual({ enabled: false, routineDays: 30, routedOrderDays: 3650 });
  });

  it("treats empty strings as unset", () => {
    expect(
      load({
        RETENTION_ENABLED: "",
        OPERATIONS_RETENTION_DAYS: "  ",
        ROUTED_ORDER_RETENTION_DAYS: "",
      }).retentionDefaults,
    ).toEqual({ enabled: true, routineDays: 90, routedOrderDays: 365 });
  });

  it.each([
    ["OPERATIONS_RETENTION_DAYS", "0"],
    ["OPERATIONS_RETENTION_DAYS", "3651"],
    ["OPERATIONS_RETENTION_DAYS", "abc"],
    ["OPERATIONS_RETENTION_DAYS", "1.5"],
    ["ROUTED_ORDER_RETENTION_DAYS", "0"],
    ["ROUTED_ORDER_RETENTION_DAYS", "3651"],
    ["RETENTION_ENABLED", "maybe"],
  ])("rejects %s=%s", (name, value) => {
    expect(() => load({ [name]: value })).toThrow(name);
  });

  it("rejects routed below routine", () => {
    expect(() =>
      load({ OPERATIONS_RETENTION_DAYS: "100", ROUTED_ORDER_RETENTION_DAYS: "99" }),
    ).toThrow(/ROUTED_ORDER_RETENTION_DAYS/);
  });

  it("raises an unset routed default to a routine default above 365", () => {
    expect(load({ OPERATIONS_RETENTION_DAYS: "400" }).retentionDefaults).toMatchObject({
      routineDays: 400,
      routedOrderDays: 400,
    });
    expect(
      load({ OPERATIONS_RETENTION_DAYS: "400", ROUTED_ORDER_RETENTION_DAYS: " " })
        .retentionDefaults,
    ).toMatchObject({ routineDays: 400, routedOrderDays: 400 });
  });

  it("keeps the routed default at 365 when routine is at or below it", () => {
    expect(load({ OPERATIONS_RETENTION_DAYS: "200" }).retentionDefaults).toMatchObject({
      routineDays: 200,
      routedOrderDays: 365,
    });
  });

  it("still rejects an explicitly set routed below a routine above 365", () => {
    expect(() =>
      load({ OPERATIONS_RETENTION_DAYS: "400", ROUTED_ORDER_RETENTION_DAYS: "365" }),
    ).toThrow(/ROUTED_ORDER_RETENTION_DAYS/);
  });
});

describe("loadConfig storage", () => {
  it("defaults the storage path and leaves the public URL unset", () => {
    expect(load()).toMatchObject({ storagePath: "/storage/pg", managerPublicUrl: undefined });
  });

  it("reads STORAGE_PATH and MANAGER_PUBLIC_URL, treating empty as unset", () => {
    expect(
      load({ STORAGE_PATH: "/mnt/pg", MANAGER_PUBLIC_URL: "https://custody.example.com" }),
    ).toMatchObject({
      storagePath: "/mnt/pg",
      managerPublicUrl: "https://custody.example.com",
    });
    expect(load({ STORAGE_PATH: "", MANAGER_PUBLIC_URL: "" })).toMatchObject({
      storagePath: "/storage/pg",
      managerPublicUrl: undefined,
    });
  });

  it("rejects a public URL that is not http(s)", () => {
    expect(() => load({ MANAGER_PUBLIC_URL: "custody.example.com" })).toThrow(/MANAGER_PUBLIC_URL/);
    expect(() => load({ MANAGER_PUBLIC_URL: "ftp://x" })).toThrow(/MANAGER_PUBLIC_URL/);
  });
});

describe("loadConfig session cookie and API docs", () => {
  it("marks the cookie Secure when MANAGER_PUBLIC_URL is https, unless overridden", () => {
    expect(load().uiCookieSecure).toBe(false);
    expect(load({ MANAGER_PUBLIC_URL: "http://localhost:3000" }).uiCookieSecure).toBe(false);
    expect(load({ MANAGER_PUBLIC_URL: "https://custody.example.com" }).uiCookieSecure).toBe(true);
    expect(
      load({ MANAGER_PUBLIC_URL: "https://custody.example.com", UI_COOKIE_SECURE: "false" })
        .uiCookieSecure,
    ).toBe(false);
    expect(load({ UI_COOKIE_SECURE: "true" }).uiCookieSecure).toBe(true);
    expect(() => load({ UI_COOKIE_SECURE: "yes" })).toThrow(/UI_COOKIE_SECURE/);
  });

  it("warns about a non-Secure cookie only for a non-loopback public URL", () => {
    const warn = (extra: Record<string, string>) => insecureCookieWarning(load(extra));
    expect(warn({})).toBeUndefined();
    expect(warn({ MANAGER_PUBLIC_URL: "http://localhost:3000" })).toBeUndefined();
    expect(warn({ MANAGER_PUBLIC_URL: "http://127.0.0.1:3000" })).toBeUndefined();
    expect(warn({ MANAGER_PUBLIC_URL: "https://custody.example.com" })).toBeUndefined();
    expect(warn({ MANAGER_PUBLIC_URL: "http://custody.example.com" })).toMatch(/not marked Secure/);
  });

  it("serves the API docs only when ENABLE_API_DOCS=true", () => {
    expect(load().enableApiDocs).toBe(false);
    expect(load({ ENABLE_API_DOCS: "true" }).enableApiDocs).toBe(true);
    expect(() => load({ ENABLE_API_DOCS: "yes" })).toThrow(/ENABLE_API_DOCS/);
  });
});
