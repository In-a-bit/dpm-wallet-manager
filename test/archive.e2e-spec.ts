import { createHash, randomUUID } from "node:crypto";
import { get as httpGet, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";

import request from "supertest";

import { API_KEY_HEADER } from "../src/common/guards/api-key.guard";
import type { OperationKind } from "../src/db/entities";
import { startHarness, type Harness } from "../src/testing/harness";

const DAY = 24 * 60 * 60_000;
const OLD = new Date(Date.now() - 10 * DAY).toISOString();
const RECENT = new Date(Date.now() - 60 * 60_000).toISOString();
const BEFORE = new Date(Date.now() - 3 * DAY).toISOString();

const OPS = "manager.operations";
const AUDIT = "manager.audit_events";
const WALLET = "wallet.audit_events";

type Download = { status: number; body: Buffer; headers: Record<string, string> };

async function download(
  harness: Harness,
  id: string,
  apiKey = harness.adminKey,
): Promise<Download> {
  const response = await request(harness.app.getHttpServer() as Server)
    .get(`/v1/archives/${id}/download`)
    .set(API_KEY_HEADER, apiKey)
    .buffer(true)
    .parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => done(null, Buffer.concat(chunks)));
    });
  return {
    status: response.status,
    body: response.body as Buffer,
    headers: response.headers,
  };
}

/**
 * Downloads and waits for the archive to be recorded as `downloaded`: the server records it once
 * its last byte is handed off, which can be just after the client has read that byte.
 */
async function downloadFully(harness: Harness, id: string): Promise<Download> {
  const response = await download(harness, id);
  expect(response.status).toBe(200);
  await waitFor(async () => (await archiveStatus(harness, id)) === "downloaded");
  return response;
}

async function waitFor(check: () => Promise<boolean> | boolean, ms = 10_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function seedOperation(harness: Harness, kind: OperationKind, createdAt: string) {
  const id = randomUUID();
  const walletId = randomUUID();
  await harness.operations.insert({
    id,
    walletId,
    signerWalletId: walletId,
    kind,
    mode: "segregated",
    requestHash: "hash",
    resultSummary: null,
    status: "signed",
    apiKeyId: null,
    uiUserId: null,
    createdAt,
  });
  return id;
}

async function seedAudit(
  harness: Harness,
  action: string,
  outcome: string,
  createdAt: string,
): Promise<number> {
  const rows: { id: number }[] = await harness.db.query(
    `INSERT INTO audit_events (action, outcome, created_at) VALUES ($1, $2, $3) RETURNING id`,
    [action, outcome, createdAt],
  );
  return rows[0]!.id;
}

async function archiveStatus(harness: Harness, id: string): Promise<string> {
  const rows: { status: string }[] = await harness.db.query(
    `SELECT status FROM archives WHERE id = $1`,
    [id],
  );
  return rows[0]!.status;
}

describe("archives", () => {
  let harness: Harness;
  const inScope: Record<string, (string | number)[]> = { [OPS]: [], [AUDIT]: [], [WALLET]: [] };
  const outOfScope: Record<string, (string | number)[]> = { [OPS]: [], [AUDIT]: [], [WALLET]: [] };
  let archive: { id: string; code: string; scope: Record<string, { maxId: number; rows: number }> };
  let adminKeyId: string;
  let nextId: string;

  beforeAll(async () => {
    harness = await startHarness({ MANAGER_PUBLIC_URL: "https://Custody.Example.com:8443/x" });
    adminKeyId = (await harness.get("/v1/api-keys/self")).body.keyId as string;

    for (let i = 0; i < 3; i++) inScope[OPS]!.push(await seedOperation(harness, "withdraw", OLD));
    outOfScope[OPS]!.push(await seedOperation(harness, "order", OLD));
    outOfScope[OPS]!.push(await seedOperation(harness, "redeem", OLD));
    outOfScope[OPS]!.push(await seedOperation(harness, "withdraw", RECENT));

    inScope[AUDIT]!.push(await seedAudit(harness, "key.create", "success", OLD));
    inScope[AUDIT]!.push(await seedAudit(harness, "sign.order", "denied", OLD));
    inScope[AUDIT]!.push(await seedAudit(harness, "meta.withdraw", "success", OLD));
    outOfScope[AUDIT]!.push(await seedAudit(harness, "sign.order", "success", OLD));
    outOfScope[AUDIT]!.push(await seedAudit(harness, "archive.create", "success", OLD));
    outOfScope[AUDIT]!.push(await seedAudit(harness, "archive.delete", "denied", OLD));
    outOfScope[AUDIT]!.push(await seedAudit(harness, "archive.cancel", "success", OLD));
    outOfScope[AUDIT]!.push(await seedAudit(harness, "key.create", "success", RECENT));

    for (let id = 1; id <= 4; id++) {
      harness.upstream.importantAudit.push({ id, createdAt: OLD, action: "x", outcome: "denied" });
      inScope[WALLET]!.push(id);
    }
    harness.upstream.importantAudit.push({ id: 5, createdAt: RECENT, action: "x", outcome: "x" });
    outOfScope[WALLET]!.push(5);
  });

  afterAll(async () => {
    await harness.close();
  });

  it("previews the important rows only, for every role", async () => {
    for (const apiKey of [harness.readonlyKey, harness.adminKey]) {
      const preview = await harness.get("/v1/archives/preview", {
        apiKey,
        query: { before: BEFORE },
      });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({ tables: { [OPS]: 3, [AUDIT]: 3, [WALLET]: 4 } });
    }
  });

  it("refuses a cutoff less than a day old", async () => {
    const recent = new Date(Date.now() - 60 * 60_000).toISOString();
    expect((await harness.post("/v1/archives", { body: { before: recent } })).status).toBe(400);
    const preview = await harness.get("/v1/archives/preview", { query: { before: recent } });
    expect(preview.status).toBe(400);
  });

  it("creates an archive with a fixed scope and a 6-character code", async () => {
    const created = await harness.post("/v1/archives", { body: { before: BEFORE } });
    expect(created.status).toBe(201);
    archive = created.body;
    expect(archive.code).toBe(archive.id.slice(0, 6).toUpperCase());
    expect(archive.scope[OPS]).toMatchObject({ rows: 3, maxId: expect.any(Number) });
    expect(archive.scope[AUDIT]).toMatchObject({ rows: 3, maxId: expect.any(Number) });
    expect(archive.scope[WALLET]).toEqual({ rows: 4, maxId: 4 });

    // Written after the scope was fixed, but dated before the cutoff: never in this archive.
    outOfScope[OPS]!.push(await seedOperation(harness, "withdraw", OLD));
    outOfScope[AUDIT]!.push(await seedAudit(harness, "key.revoke", "success", OLD));
    harness.upstream.importantAudit.push({ id: 6, createdAt: OLD, action: "x", outcome: "denied" });
    outOfScope[WALLET]!.push(6);
  });

  it("refuses a viewer on create, download and delete, and serves list and preview", async () => {
    const apiKey = harness.readonlyKey;
    expect((await harness.post("/v1/archives", { apiKey, body: { before: BEFORE } })).status).toBe(
      403,
    );
    expect((await download(harness, archive.id, apiKey)).status).toBe(403);
    const del = await harness.post(`/v1/archives/${archive.id}/delete`, {
      apiKey,
      body: { code: archive.code },
    });
    expect(del.status).toBe(403);
    expect((await harness.get("/v1/archives", { apiKey })).status).toBe(200);
    const preview = await harness.get("/v1/archives/preview", {
      apiKey,
      query: { before: BEFORE },
    });
    expect(preview.status).toBe(200);
  });

  it("404s an unknown archive", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    const response = await harness.post(`/v1/archives/${unknown}/delete`, {
      body: { code: "000000" },
    });
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe("ARCHIVE_NOT_FOUND");
    expect((await download(harness, unknown)).status).toBe(404);
  });

  it("leaves a broken-off download pending, and refuses to delete it", async () => {
    const server = harness.app.getHttpServer() as Server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;

    let release: () => void = () => undefined;
    harness.upstream.holdExport = new Promise<void>((resolve) => (release = resolve));
    const exportsBefore = harness.upstream.requests.length;
    const call = httpGet({
      host: "127.0.0.1",
      port,
      path: `/v1/archives/${archive.id}/download`,
      headers: { [API_KEY_HEADER]: harness.adminKey },
    });
    call.on("error", () => undefined);
    // The manager rows are written; the stream is waiting on dpm-wallet's first page.
    await waitFor(() =>
      harness.upstream.requests
        .slice(exportsBefore)
        .some((r) => r.path.startsWith("/v1/maintenance/audit-export")),
    );
    call.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    harness.upstream.holdExport = undefined;
    release();
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(await archiveStatus(harness, archive.id)).toBe("pending");
    const del = await harness.post(`/v1/archives/${archive.id}/delete`, {
      body: { code: archive.code },
    });
    expect(del.status).toBe(409);
    expect(del.body.error.code).toBe("ARCHIVE_NOT_READY");
  });

  it("answers an error, not a cut-off file, when dpm-wallet is down before the first byte", async () => {
    harness.upstream.failNextWith(503, "UNAVAILABLE", "dpm-wallet is down");
    const response = await download(harness, archive.id);
    // UPSTREAM_UNAVAILABLE is this service's fixed 502 (ERROR_STATUS), as on every other route.
    expect(response.status).toBe(502);
    expect(response.headers["content-type"]).toMatch(/^application\/json/);
    expect(JSON.parse(response.body.toString("utf8"))).toMatchObject({
      error: { code: "UPSTREAM_UNAVAILABLE" },
    });
    expect(await archiveStatus(harness, archive.id)).toBe("pending");
  });

  it("streams the scope as gzipped ndjson and records its SHA-256", async () => {
    const response = await downloadFully(harness, archive.id);
    expect(response.headers["content-type"]).toBe("application/gzip");
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    expect(response.headers["content-disposition"]).toBe(
      `attachment; filename="dpm-archive-custody.example.com-${today}-${archive.code}.ndjson.gz"`,
    );

    const lines = gunzipSync(response.body)
      .toString("utf8")
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line) as { table?: string; row?: { id: string | number } });
    expect(lines[0]).toEqual({
      archiveId: archive.id,
      install: "custody.example.com",
      mode: "segregated",
      createdAt: expect.any(String),
      before: BEFORE,
      tables: archive.scope,
    });
    const ids: Record<string, (string | number)[]> = { [OPS]: [], [AUDIT]: [], [WALLET]: [] };
    for (const line of lines.slice(1)) {
      expect(Object.keys(line).sort()).toEqual(["row", "table"]);
      ids[line.table!]!.push(line.row!.id);
    }
    for (const table of [OPS, AUDIT, WALLET]) {
      expect([...ids[table]!].sort()).toEqual([...inScope[table]!].sort());
    }
    const op = lines.find((line) => line.table === OPS)!.row;
    expect(op).toMatchObject({ kind: "withdraw", createdAt: OLD });

    const rows: { status: string; sha256: string; byte_size: string; row_count: number }[] =
      await harness.db.query(`SELECT * FROM archives WHERE id = $1`, [archive.id]);
    expect(rows[0]).toMatchObject({
      status: "downloaded",
      sha256: createHash("sha256").update(response.body).digest("hex"),
      byte_size: String(response.body.length),
      row_count: 10,
    });
  });

  it("refuses a second archive while one is not done", async () => {
    const second = await harness.post("/v1/archives", { body: { before: BEFORE } });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("ARCHIVE_IN_PROGRESS");
  });

  it("refuses the wrong code and deletes nothing", async () => {
    const wrong = await harness.post(`/v1/archives/${archive.id}/delete`, {
      body: { code: "ZZZZZZ" },
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error.code).toBe("ARCHIVE_CODE_MISMATCH");
    expect(await archiveStatus(harness, archive.id)).toBe("downloaded");
    const preview = await harness.get("/v1/archives/preview", { query: { before: BEFORE } });
    // The late rows (dated before the cutoff) now count too: the preview is live, the scope fixed.
    expect(preview.body.tables).toEqual({ [OPS]: 4, [AUDIT]: 4, [WALLET]: 5 });
  });

  it("deletes exactly the archived rows in the background, then reports done", async () => {
    const accepted = await harness.post(`/v1/archives/${archive.id}/delete`, {
      body: { code: archive.code.toLowerCase() },
    });
    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({ status: "deleting" });

    await waitFor(async () => (await archiveStatus(harness, archive.id)) === "done");

    const ops: { id: string }[] = await harness.db.query(`SELECT id FROM operations`);
    const opIds = ops.map((r) => r.id);
    for (const id of inScope[OPS]!) expect(opIds).not.toContain(id);
    for (const id of outOfScope[OPS]!) expect(opIds).toContain(id);

    const audit: { id: number }[] = await harness.db.query(`SELECT id FROM audit_events`);
    const auditIds = audit.map((r) => r.id);
    for (const id of inScope[AUDIT]!) expect(auditIds).not.toContain(id);
    for (const id of outOfScope[AUDIT]!) expect(auditIds).toContain(id);

    expect(harness.upstream.importantAudit.map((r) => r.id).sort()).toEqual([5, 6]);

    const list = await harness.get("/v1/archives");
    expect(list.status).toBe(200);
    const item = (list.body.items as Record<string, unknown>[]).find((a) => a.id === archive.id);
    expect(item).toMatchObject({
      code: archive.code,
      status: "done",
      deleted: { [OPS]: 3, [AUDIT]: 3, [WALLET]: 4 },
      rowCount: 10,
      createdByKeyId: adminKeyId,
      deletedAt: expect.any(String),
      downloadedAt: expect.any(String),
    });
    expect(list.body.total).toBeGreaterThanOrEqual(1);
  });

  it("allows a new archive once the last one is done", async () => {
    const next = await harness.post("/v1/archives", { body: { before: BEFORE } });
    expect(next.status).toBe(201);
    nextId = next.body.id as string;
    // The late rows are what this one covers.
    expect(next.body.scope).toMatchObject({
      [OPS]: { rows: 1 },
      [AUDIT]: { rows: 1 },
      [WALLET]: { rows: 1 },
    });
  });

  it("writes an archive.* audit event with the actor for every step", async () => {
    const events = (await harness.get("/v1/audit", { query: { limit: 200 } })).body.items.filter(
      (e: { action: string }) => e.action.startsWith("archive."),
    ) as {
      action: string;
      outcome: string;
      actorKeyId: string | null;
      detail: Record<string, unknown> | null;
    }[];
    const mine = events.filter((e) => e.detail?.archiveId === archive.id);
    const seen = mine.map((e) => `${e.action}:${e.outcome}`);
    expect(seen).toEqual(
      expect.arrayContaining([
        "archive.create:success",
        "archive.download:failure",
        "archive.download:success",
        "archive.delete:denied",
        "archive.delete:success",
      ]),
    );
    for (const event of mine) expect(event.actorKeyId).toBe(adminKeyId);
  });

  describe("cancel", () => {
    async function counts(): Promise<number[]> {
      const ops: { n: number }[] = await harness.db.query(
        `SELECT COUNT(*)::int AS n FROM operations`,
      );
      const audit: { n: number }[] = await harness.db.query(
        `SELECT COUNT(*)::int AS n FROM audit_events WHERE action NOT LIKE 'archive.%'`,
      );
      return [ops[0]!.n, audit[0]!.n, harness.upstream.importantAudit.length];
    }

    it("refuses a done archive", async () => {
      const response = await harness.post(`/v1/archives/${archive.id}/cancel`);
      expect(response.status).toBe(409);
      expect(response.body.error.code).toBe("ARCHIVE_NOT_CANCELLABLE");
    });

    it("refuses a viewer", async () => {
      const response = await harness.post(`/v1/archives/${nextId}/cancel`, {
        apiKey: harness.readonlyKey,
      });
      expect(response.status).toBe(403);
    });

    it("abandons a downloaded archive without touching a record, then allows a new one", async () => {
      await downloadFully(harness, nextId);
      const before = await counts();

      const response = await harness.post(`/v1/archives/${nextId}/cancel`);
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: "cancelled" });
      expect(await counts()).toEqual(before);
      expect(await archiveStatus(harness, nextId)).toBe("cancelled");
      // A cancelled archive cannot be downloaded or deleted, and stays in the history.
      expect((await download(harness, nextId)).status).toBe(409);
      const code = nextId.slice(0, 6).toUpperCase();
      const del = await harness.post(`/v1/archives/${nextId}/delete`, { body: { code } });
      expect(del.status).toBe(409);
      const list = await harness.get("/v1/archives");
      expect(list.body.items.map((a: { id: string }) => a.id)).toContain(nextId);

      const created = await harness.post("/v1/archives", { body: { before: BEFORE } });
      expect(created.status).toBe(201);
      // Deleting is past the point of no return.
      await harness.db.query(`UPDATE archives SET status = 'deleting' WHERE id = $1`, [
        created.body.id,
      ]);
      const deleting = await harness.post(`/v1/archives/${created.body.id}/cancel`);
      expect(deleting.status).toBe(409);
      expect(deleting.body.error.code).toBe("ARCHIVE_NOT_CANCELLABLE");
      expect(await counts()).toEqual(before);

      const events = (await harness.get("/v1/audit", { query: { action: "archive.cancel" } })).body
        .items as { outcome: string; actorKeyId: string; detail: { archiveId: string } | null }[];
      const mine = events.filter((e) => e.detail?.archiveId === nextId);
      expect(mine.map((e) => e.outcome)).toEqual(["success"]);
      expect(mine[0]!.actorKeyId).toBe(adminKeyId);
    });
  });
});

describe("archives after a restart", () => {
  it("resumes a delete left in the deleting state", async () => {
    const harness = await startHarness();
    try {
      const id = await seedOperation(harness, "withdraw", OLD);
      const created = await harness.post("/v1/archives", { body: { before: BEFORE } });
      expect(created.status).toBe(201);
      await downloadFully(harness, created.body.id as string);
      // As if the container died mid-delete.
      await harness.db.query(`UPDATE archives SET status = 'deleting' WHERE id = $1`, [
        created.body.id,
      ]);

      const rebooted = await startHarness(
        { DATABASE_URL: (harness.db.options as { url: string }).url },
        { upstream: harness.upstream },
      );
      try {
        await waitFor(async () => (await archiveStatus(harness, created.body.id)) === "done");
        const ops: unknown[] = await harness.db.query(`SELECT 1 FROM operations WHERE id = $1`, [
          id,
        ]);
        expect(ops).toHaveLength(0);
      } finally {
        await rebooted.stop();
      }
    } finally {
      await harness.close();
    }
  });
});

describe("archives scope recount", () => {
  it("refuses the delete, leaving the archive downloaded, when the scope count changed", async () => {
    const harness = await startHarness();
    try {
      const kept = await seedOperation(harness, "withdraw", OLD);
      const removed = await seedOperation(harness, "withdraw", OLD);
      const created = await harness.post("/v1/archives", { body: { before: BEFORE } });
      await downloadFully(harness, created.body.id as string);
      await harness.db.query(`DELETE FROM operations WHERE id = $1`, [removed]);

      const response = await harness.post(`/v1/archives/${created.body.id}/delete`, {
        body: { code: created.body.code },
      });
      expect(response.status).toBe(409);
      expect(response.body.error).toMatchObject({
        code: "ARCHIVE_SCOPE_CHANGED",
        details: { tables: [OPS] },
      });
      expect(await archiveStatus(harness, created.body.id)).toBe("downloaded");
      const ops: unknown[] = await harness.db.query(`SELECT 1 FROM operations WHERE id = $1`, [
        kept,
      ]);
      expect(ops).toHaveLength(1);
    } finally {
      await harness.close();
    }
  });
});

describe("archives migration", () => {
  it("numbers only new operations, and archives the unnumbered old ones by created_at", async () => {
    const harness = await startHarness();
    try {
      // Back to before the archive migrations, with rows already in the table.
      await harness.db.undoLastMigration();
      await harness.db.undoLastMigration();
      const existing = await seedOperation(harness, "withdraw", OLD);
      const routine = await seedOperation(harness, "order", OLD);
      await harness.db.runMigrations();

      const seqs: { id: string; seq: string | null }[] = await harness.db.query(
        `SELECT id, seq::text AS seq FROM operations`,
      );
      // No rewrite: the existing rows were left without a number.
      expect(seqs.every((r) => r.seq === null)).toBe(true);
      const index: { valid: boolean }[] = await harness.db.query(
        `SELECT i.indisvalid AS valid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'operations_archive_seq'`,
      );
      expect(index).toEqual([{ valid: true }]);

      const created = await harness.post("/v1/archives", { body: { before: BEFORE } });
      expect(created.body.scope[OPS]).toEqual({ maxId: 0, rows: 1 });
      // Written after the scope was fixed, dated before the cutoff: numbered, so out of scope.
      const late = await seedOperation(harness, "withdraw", OLD);
      const lateSeq: { seq: string }[] = await harness.db.query(
        `SELECT seq::text AS seq FROM operations WHERE id = $1`,
        [late],
      );
      expect(Number(lateSeq[0]!.seq)).toBeGreaterThan(0);

      const file = await downloadFully(harness, created.body.id as string);
      const rows = gunzipSync(file.body)
        .toString("utf8")
        .trimEnd()
        .split("\n")
        .slice(1)
        .map((line) => (JSON.parse(line) as { row: { id: string } }).row.id);
      expect(rows).toEqual([existing]);

      await harness.post(`/v1/archives/${created.body.id}/delete`, {
        body: { code: created.body.code },
      });
      await waitFor(async () => (await archiveStatus(harness, created.body.id)) === "done");
      const left: { id: string }[] = await harness.db.query(`SELECT id FROM operations`);
      expect(left.map((r) => r.id).sort()).toEqual([late, routine].sort());
    } finally {
      await harness.close();
    }
  });
});
