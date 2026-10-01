import { reaches } from "./roles.guard";

describe("role hierarchy", () => {
  it("lets each role reach its own routes and everything below", () => {
    expect(reaches("admin", ["operator"])).toBe(true);
    expect(reaches("admin", ["admin"])).toBe(true);
    expect(reaches("operator", ["operator"])).toBe(true);
    expect(reaches("readonly", ["readonly"])).toBe(true);
    expect(reaches("operator", ["readonly"])).toBe(true);
  });

  it("keeps each role off what is above it", () => {
    expect(reaches("operator", ["admin"])).toBe(false);
    expect(reaches("readonly", ["operator"])).toBe(false);
    expect(reaches("readonly", ["admin"])).toBe(false);
  });
});
