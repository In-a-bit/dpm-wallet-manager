import crypto from "node:crypto";
import { Transform, type TransformCallback } from "node:stream";

/**
 * Sealed backups. A backup artifact is encrypted to a recovery public key kept on the install, so
 * the machine can write backups but not read them: the matching private key is shown once at setup
 * and never stored here.
 *
 * Format (v1): "DPMBK1" | ephemeral X25519 public key (32) | HKDF salt (16) | chunk size (u32 BE)
 * then AES-256-GCM chunks, each plaintext chunk-size bytes except the last (1..chunk-size, or empty
 * for an empty input), each followed by its 16-byte tag. The key is HKDF-SHA256 over the ECDH
 * secret, bound to both public keys. The header is the AAD of every chunk; the nonce carries the
 * chunk's number and whether it is the last, so reordering, dropping, truncating or extending the
 * stream fails authentication.
 */
const MAGIC = Buffer.from("DPMBK1");
const KEY_BYTES = 32;
const SALT_BYTES = 16;
const HEADER_BYTES = MAGIC.length + KEY_BYTES + SALT_BYTES + 4;
const TAG_BYTES = 16;
const CHUNK_BYTES = 64 * 1024;
const INFO = Buffer.from("dpm-custody backup v1");

export const RECIPIENT_PREFIX = "dpmbk_pub_";
export const RECOVERY_KEY_PREFIX = "dpmbk_key_";

const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");

export class BackupCryptoError extends Error {}

export type RecoveryKeyPair = { recipient: string; recoveryKey: string };

/** A new recovery key pair. The recipient goes on the install; the recovery key is shown once. */
export function generateRecoveryKeyPair(): RecoveryKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    recipient: RECIPIENT_PREFIX + rawPublic(publicKey).toString("base64url"),
    recoveryKey: RECOVERY_KEY_PREFIX + rawPrivate(privateKey).toString("base64url"),
  };
}

/** The recipient (public) string that goes with a recovery key. */
export function recipientOf(recoveryKey: string): string {
  const privateKey = importPrivate(recoveryKey);
  return RECIPIENT_PREFIX + rawPublic(crypto.createPublicKey(privateKey)).toString("base64url");
}

/** Encrypts a stream to `recipient`. */
export function sealer(recipient: string): Transform {
  const recipientKey = importPublic(recipient);
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const ephemeralPublic = rawPublic(ephemeral.publicKey);
  const salt = crypto.randomBytes(SALT_BYTES);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(CHUNK_BYTES);
  const header = Buffer.concat([MAGIC, ephemeralPublic, salt, size]);
  const key = deriveKey(
    crypto.diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipientKey }),
    salt,
    ephemeralPublic,
    rawPublic(recipientKey),
  );

  let pending = Buffer.alloc(0);
  let counter = 0;
  let started = false;
  const encrypt = (plain: Buffer, last: boolean): Buffer => {
    const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce(counter++, last), {
      authTagLength: TAG_BYTES,
    });
    cipher.setAAD(header);
    return Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (!started) {
        started = true;
        this.push(header);
      }
      pending = Buffer.concat([pending, chunk]);
      // Strictly more than a chunk: whatever remains at the end is the last chunk, never empty
      // unless the whole input was.
      while (pending.length > CHUNK_BYTES) {
        this.push(encrypt(pending.subarray(0, CHUNK_BYTES), false));
        pending = pending.subarray(CHUNK_BYTES);
      }
      callback();
    },
    flush(callback) {
      if (!started) this.push(header);
      this.push(encrypt(pending, true));
      callback();
    },
  });
}

/** Decrypts a sealed stream with `recoveryKey`; fails on anything that is not authentic. */
export function opener(recoveryKey: string): Transform {
  const privateKey = importPrivate(recoveryKey);
  const recipientPublic = rawPublic(crypto.createPublicKey(privateKey));
  let buffer = Buffer.alloc(0);
  let header: Buffer | undefined;
  let key: Buffer | undefined;
  let chunkBytes = 0;
  let counter = 0;

  const decrypt = (unit: Buffer, last: boolean): Buffer => {
    if (!header || !key) throw new BackupCryptoError("The backup has no header.");
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, nonce(counter++, last), {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(header);
    decipher.setAuthTag(unit.subarray(unit.length - TAG_BYTES));
    try {
      return Buffer.concat([
        decipher.update(unit.subarray(0, unit.length - TAG_BYTES)),
        decipher.final(),
      ]);
    } catch {
      throw new BackupCryptoError(
        "The backup does not authenticate: wrong recovery key, or the file is damaged or was changed.",
      );
    }
  };
  const readHeader = (): void => {
    if (header || buffer.length < HEADER_BYTES) return;
    header = buffer.subarray(0, HEADER_BYTES);
    buffer = buffer.subarray(HEADER_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new BackupCryptoError("This is not a sealed backup (unknown header).");
    }
    const ephemeralPublic = header.subarray(MAGIC.length, MAGIC.length + KEY_BYTES);
    const salt = header.subarray(MAGIC.length + KEY_BYTES, MAGIC.length + KEY_BYTES + SALT_BYTES);
    chunkBytes = header.readUInt32BE(HEADER_BYTES - 4);
    if (chunkBytes < 1 || chunkBytes > 16 * 1024 * 1024) {
      throw new BackupCryptoError("This is not a sealed backup (bad chunk size).");
    }
    key = deriveKey(
      crypto.diffieHellman({ privateKey, publicKey: publicFromRaw(ephemeralPublic) }),
      salt,
      ephemeralPublic,
      recipientPublic,
    );
  };

  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      try {
        buffer = Buffer.concat([buffer, chunk]);
        readHeader();
        const unit = chunkBytes + TAG_BYTES;
        // A full unit is final only if nothing follows it, so hold back the last bytes.
        while (header && buffer.length > unit) {
          this.push(decrypt(buffer.subarray(0, unit), false));
          buffer = buffer.subarray(unit);
        }
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
    flush(callback: TransformCallback) {
      try {
        readHeader();
        if (!header) throw new BackupCryptoError("The backup is empty or cut short.");
        if (buffer.length < TAG_BYTES) throw new BackupCryptoError("The backup is cut short.");
        this.push(decrypt(buffer, true));
        callback();
      } catch (err) {
        callback(err as Error);
      }
    },
  });
}

function nonce(counter: number, last: boolean): Buffer {
  const out = Buffer.alloc(12);
  out.writeBigUInt64BE(BigInt(counter), 0);
  out[11] = last ? 1 : 0;
  return out;
}

function deriveKey(secret: Buffer, salt: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(
    crypto.hkdfSync("sha256", secret, salt, Buffer.concat([INFO, ephemeral, recipient]), KEY_BYTES),
  );
}

function rawPublic(key: crypto.KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" }).subarray(SPKI_X25519.length);
}

function rawPrivate(key: crypto.KeyObject): Buffer {
  return key.export({ type: "pkcs8", format: "der" }).subarray(PKCS8_X25519.length);
}

function publicFromRaw(raw: Buffer): crypto.KeyObject {
  return crypto.createPublicKey({
    key: Buffer.concat([SPKI_X25519, raw]),
    format: "der",
    type: "spki",
  });
}

function importPublic(recipient: string): crypto.KeyObject {
  const raw = decode(recipient.trim(), RECIPIENT_PREFIX, "recipient");
  return publicFromRaw(raw);
}

function importPrivate(recoveryKey: string): crypto.KeyObject {
  const raw = decode(recoveryKey.trim(), RECOVERY_KEY_PREFIX, "recovery key");
  return crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_X25519, raw]),
    format: "der",
    type: "pkcs8",
  });
}

function decode(text: string, prefix: string, what: string): Buffer {
  if (!text.startsWith(prefix)) throw new BackupCryptoError(`That is not a backup ${what}.`);
  const raw = Buffer.from(text.slice(prefix.length), "base64url");
  if (raw.length !== KEY_BYTES) throw new BackupCryptoError(`That is not a backup ${what}.`);
  return raw;
}
