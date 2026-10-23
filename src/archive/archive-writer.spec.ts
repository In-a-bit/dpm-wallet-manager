import { createHash } from "node:crypto";
import { PassThrough, Writable } from "node:stream";
import { gunzipSync } from "node:zlib";

import { archiveCode, archiveFileName, installName, writeArchive } from "./archive-writer";

async function* records(values: unknown[], failAfter?: number): AsyncGenerator<unknown> {
  let i = 0;
  for (const value of values) {
    if (failAfter !== undefined && i++ === failAfter) throw new Error("source failed");
    yield value;
  }
}

function collect(): { out: PassThrough; bytes: () => Buffer } {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on("data", (chunk: Buffer) => chunks.push(chunk));
  return { out, bytes: () => Buffer.concat(chunks) };
}

describe("writeArchive", () => {
  it("writes gzipped ndjson and reports the SHA-256 and size of the bytes sent", async () => {
    const { out, bytes } = collect();
    const file = await writeArchive(
      records([{ manifest: true }, { table: "t", row: { id: 1 } }]),
      out,
    );
    const sent = bytes();
    expect(gunzipSync(sent).toString()).toBe('{"manifest":true}\n{"table":"t","row":{"id":1}}\n');
    expect(file).toEqual({
      sha256: createHash("sha256").update(sent).digest("hex"),
      byteSize: sent.length,
    });
  });

  it("rejects, without a gzip trailer, when the source fails", async () => {
    const { out, bytes } = collect();
    await expect(writeArchive(records([1, 2, 3], 2), out)).rejects.toThrow("source failed");
    expect(() => gunzipSync(bytes())).toThrow();
  });

  it("rejects when the destination closes before the end", async () => {
    const out = new Writable({
      write(_chunk, _encoding, done) {
        done();
        out.destroy();
      },
    });
    const many = Array.from({ length: 50_000 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    await expect(writeArchive(records(many), out)).rejects.toThrow();
  });
});

describe("file naming", () => {
  it("names the install by the public URL's host, sanitised, else install", () => {
    expect(installName("https://Custody.Example.com:8443/path")).toBe("custody.example.com");
    expect(installName(undefined)).toBe("install");
    expect(installName("not a url")).toBe("install");
  });

  it("builds the file name from the install, the creation day and the code", () => {
    const id = "3f9a1c2e-7b44-4c1d-9d0e-6a3b5c7d8e9f";
    expect(archiveCode(id)).toBe("3F9A1C");
    expect(archiveFileName("acme.io", "2026-10-23T23:59:00.000Z", id)).toBe(
      "dpm-archive-acme.io-20261023-3F9A1C.ndjson.gz",
    );
  });
});
