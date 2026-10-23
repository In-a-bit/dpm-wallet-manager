import { ManagerError } from "../../errors";

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * An opaque position in a newest-first listing: the last row's timestamp and id. Base64url JSON,
 * so a client can only hand it back. The id is a string because audit ids are integers and
 * operation ids are uuids.
 */
export function encodeCursor(createdAt: string, id: string | number): string {
  return Buffer.from(JSON.stringify({ createdAt, id: String(id) })).toString("base64url");
}

export function decodeCursor(raw: string): { createdAt: string; id: string } {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      const { createdAt, id } = parsed as Record<string, unknown>;
      if (
        typeof createdAt === "string" &&
        ISO.test(createdAt) &&
        !Number.isNaN(Date.parse(createdAt)) &&
        typeof id === "string" &&
        id.length > 0
      ) {
        return { createdAt, id };
      }
    }
  } catch {
    // falls through to the one error below
  }
  throw invalidCursor();
}

export function invalidCursor(): ManagerError {
  return new ManagerError("INVALID_CURSOR", "The cursor is not one this service issued");
}
