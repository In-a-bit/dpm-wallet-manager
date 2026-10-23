import { createHash } from "node:crypto";
import { Readable, Transform, type TransformCallback, type Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** What a complete file was: the SHA-256 (hex) and size of the gzipped bytes as sent. */
export type WrittenFile = { sha256: string; byteSize: number };

/** Passes bytes through unchanged while hashing and counting them. */
export class HashingTransform extends Transform {
  private readonly hash = createHash("sha256");
  byteSize = 0;

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.hash.update(chunk);
    this.byteSize += chunk.length;
    done(null, chunk);
  }

  digest(): string {
    return this.hash.digest("hex");
  }
}

/**
 * Streams `records` as gzipped ndjson (one JSON value per line) into `out`, hashing the gzipped
 * bytes on the way.
 *
 * Resolves only once every byte has been handed to `out` and it has finished. Rejects when `out`
 * closes first (a client that broke off), or when `records` throws: the gzip trailer is then never
 * written, so a partial file cannot pass for a complete one.
 */
export async function writeArchive(
  records: AsyncIterable<unknown>,
  out: Writable,
): Promise<WrittenFile> {
  const hasher = new HashingTransform();
  await pipeline(Readable.from(ndjson(records), { objectMode: false }), createGzip(), hasher, out);
  return { sha256: hasher.digest(), byteSize: hasher.byteSize };
}

async function* ndjson(records: AsyncIterable<unknown>): AsyncGenerator<Buffer> {
  for await (const record of records) yield Buffer.from(`${JSON.stringify(record)}\n`);
}

/**
 * The install's name for a file name: the host of `MANAGER_PUBLIC_URL`, lower-cased and kept to
 * `[a-z0-9.-]`, or `install` when there is none.
 */
export function installName(publicUrl: string | undefined): string {
  if (!publicUrl) return "install";
  let host: string;
  try {
    host = new URL(publicUrl).hostname;
  } catch {
    return "install";
  }
  const clean = host.toLowerCase().replace(/[^a-z0-9.-]/g, "");
  return clean === "" ? "install" : clean;
}

/** The 6-character code an operator types to confirm a delete: the id's first 6, upper-cased. */
export function archiveCode(id: string): string {
  return id.slice(0, 6).toUpperCase();
}

/** `dpm-archive-<install>-<yyyymmdd>-<code>.ndjson.gz`, dated by the archive's creation (UTC). */
export function archiveFileName(install: string, createdAt: string, id: string): string {
  const day = createdAt.slice(0, 10).replace(/-/g, "");
  return `dpm-archive-${install}-${day}-${archiveCode(id)}.ndjson.gz`;
}
