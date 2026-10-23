import { loadConfig } from "./config";
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

  it("rejects a routine default above the routed default", () => {
    expect(() => load({ OPERATIONS_RETENTION_DAYS: "400" })).toThrow(/ROUTED_ORDER_RETENTION_DAYS/);
  });
});
