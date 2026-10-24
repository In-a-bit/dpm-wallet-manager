import { pipeline } from "node:stream/promises";
import { Readable, Writable } from "node:stream";
import crypto from "node:crypto";

import {
  BackupCryptoError,
  generateRecoveryKeyPair,
  opener,
  recipientOf,
  sealer,
} from "./backup-crypto";

async function run(transform: NodeJS.ReadWriteStream, input: Buffer, pieces = 1): Promise<Buffer> {
  const size = Math.max(1, Math.ceil(input.length / pieces));
  const parts: Buffer[] = [];
  for (let i = 0; i < input.length; i += size) parts.push(input.subarray(i, i + size));
  const out: Buffer[] = [];
  await pipeline(
    Readable.from(parts.length ? parts : []),
    transform,
    new Writable({
      write(chunk: Buffer, _enc, cb) {
        out.push(chunk);
        cb();
      },
    }),
  );
  return Buffer.concat(out);
}

const seal = (recipient: string, data: Buffer, pieces?: number) =>
  run(sealer(recipient), data, pieces);
const open = (key: string, data: Buffer, pieces?: number) => run(opener(key), data, pieces);

describe("sealed backups", () => {
  const { recipient, recoveryKey } = generateRecoveryKeyPair();
  const CHUNK = 64 * 1024;

  it("derives the recipient from the recovery key, and keeps them distinct", () => {
    expect(recipientOf(recoveryKey)).toBe(recipient);
    expect(recipient).toMatch(/^dpmbk_pub_/);
    expect(recoveryKey).toMatch(/^dpmbk_key_/);
  });

  it.each([0, 1, 100, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 3 * CHUNK + 17])(
    "round-trips %i bytes, however the stream is cut up",
    async (size) => {
      const data = crypto.randomBytes(size);
      const sealed = await seal(recipient, data, 7);
      expect(sealed.length).toBeGreaterThan(size);
      expect(await open(recoveryKey, sealed, 13)).toEqual(data);
    },
  );

  it("does not contain the plaintext, and differs every time", async () => {
    const data = Buffer.from("PLAINTEXT-MARKER ".repeat(100));
    const a = await seal(recipient, data);
    const b = await seal(recipient, data);
    expect(a.includes("PLAINTEXT-MARKER")).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it("refuses another recovery key", async () => {
    const sealed = await seal(recipient, Buffer.from("secret"));
    await expect(open(generateRecoveryKeyPair().recoveryKey, sealed)).rejects.toBeInstanceOf(
      BackupCryptoError,
    );
  });

  it("detects a changed byte anywhere: header, body or tag", async () => {
    const data = crypto.randomBytes(2 * CHUNK + 5);
    const sealed = await seal(recipient, data);
    for (const at of [3, 10, 50, 60, 1000, CHUNK + 100, sealed.length - 1]) {
      const tampered = Buffer.from(sealed);
      tampered[at] = (tampered[at] as number) ^ 0x01;
      await expect(open(recoveryKey, tampered)).rejects.toThrow();
    }
  });

  it("detects truncation, extension and reordered chunks", async () => {
    const data = crypto.randomBytes(3 * CHUNK + 5);
    const sealed = await seal(recipient, data);
    const unit = CHUNK + 16;
    const header = sealed.subarray(0, 6 + 32 + 16 + 4);
    const body = sealed.subarray(header.length);
    // Whole chunks dropped from the end (what an interrupted write looks like).
    await expect(open(recoveryKey, sealed.subarray(0, header.length + unit))).rejects.toThrow();
    await expect(open(recoveryKey, sealed.subarray(0, sealed.length - 1))).rejects.toThrow();
    await expect(open(recoveryKey, Buffer.concat([sealed, Buffer.from([0])]))).rejects.toThrow();
    // Two chunks swapped.
    const swapped = Buffer.concat([
      header,
      body.subarray(unit, 2 * unit),
      body.subarray(0, unit),
      body.subarray(2 * unit),
    ]);
    await expect(open(recoveryKey, swapped)).rejects.toThrow();
    await expect(open(recoveryKey, Buffer.alloc(0))).rejects.toThrow();
    await expect(
      open(recoveryKey, Buffer.from("not a backup at all, just text")),
    ).rejects.toThrow();
  });

  it("rejects malformed keys", () => {
    expect(() => sealer("nope")).toThrow(BackupCryptoError);
    expect(() => opener(recipient)).toThrow(BackupCryptoError);
    expect(() => sealer(recoveryKey)).toThrow(BackupCryptoError);
  });
});
