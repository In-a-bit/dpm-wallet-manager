import { ManagerError } from "../../errors";
import { decodeCursor, encodeCursor } from "./cursor";

const b64 = (value: string) => Buffer.from(value).toString("base64url");

describe("cursor", () => {
  it("round-trips a timestamp and an id of either type", () => {
    const createdAt = "2026-10-23T10:00:00.123Z";
    expect(decodeCursor(encodeCursor(createdAt, 42))).toEqual({ createdAt, id: "42" });
    const uuid = "3f2b8d0e-8a41-4c43-9a43-2a1f6a1c7d10";
    expect(decodeCursor(encodeCursor(createdAt, uuid))).toEqual({ createdAt, id: uuid });
  });

  it.each([
    ["not base64 json", "!!"],
    ["json without the fields", b64('{"x":1}')],
    ["a non-ISO createdAt", b64('{"createdAt":"yesterday","id":"1"}')],
    ["an empty id", b64('{"createdAt":"2026-10-23T10:00:00Z","id":""}')],
  ])("rejects %s with INVALID_CURSOR", (_name, raw) => {
    try {
      decodeCursor(raw);
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ManagerError);
      expect((error as ManagerError).code).toBe("INVALID_CURSOR");
      expect((error as ManagerError).status).toBe(400);
    }
  });
});
