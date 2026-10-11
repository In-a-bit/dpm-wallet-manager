import fs from "node:fs";
import path from "node:path";

/**
 * What happened during setup, one JSON line per event, appended to the config volume. The worker
 * and the terminal both write to it; the dashboard tails it for live detail, and the support
 * report ships it. Every line is masked before it is written, so the file is safe to send.
 */
export type JournalEvent =
  | { type: "step.start"; step: string }
  | { type: "step.progress"; step: string; message: string }
  | { type: "step.done"; step: string; ms: number; result?: string }
  | { type: "step.fail"; step: string; ms: number; error: string }
  | {
      type: "http";
      step?: string;
      method: string;
      url: string;
      ms: number;
      status?: number;
      excerpt?: string;
      error?: string;
    }
  | { type: "note"; message: string; step?: string };

export type JournalEntry = JournalEvent & { at: string; pid: number };

export const JOURNAL_FILE = "setup-journal.jsonl";
const MAX_EXCERPT = 300;

/**
 * Keys that may appear in a URL, an error or a response: shown by their shape and last four
 * characters, which is enough for support to tell which key was used and never enough to use it.
 */
const KEY_PATTERNS = [
  /bld_sk_[A-Za-z0-9_-]{4,}/g,
  /dpmm_[a-z0-9]+_[a-z]{2}_[a-z0-9]{8,}/g,
  /dpmw_[a-f0-9]{8,}/g,
];

export function mask(text: string, secrets: readonly string[] = []): string {
  let masked = text;
  for (const secret of secrets) {
    if (secret.length >= 8) masked = masked.split(secret).join(maskOne(secret));
  }
  for (const pattern of KEY_PATTERNS) masked = masked.replace(pattern, maskOne);
  return masked;
}

function maskOne(secret: string): string {
  const shape = /^(bld_sk_|dpmm_[a-z0-9]+_[a-z]{2}_|dpmw_)/.exec(secret)?.[1] ?? "";
  return `${shape}…${secret.slice(-4)}`;
}

/** A response body cut down to what helps support, with any key in it masked. */
export function excerpt(body: unknown): string | undefined {
  if (body === undefined || body === "") return undefined;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return text.length > MAX_EXCERPT ? `${text.slice(0, MAX_EXCERPT)}…` : text;
}

export class Journal {
  constructor(
    private readonly configDir: string,
    /** The secrets known right now, read at every write: they appear once setup has started. */
    private readonly secrets: () => readonly string[] = () => [],
  ) {}

  get file(): string {
    return path.join(this.configDir, JOURNAL_FILE);
  }

  append(event: JournalEvent): void {
    const entry: JournalEntry = { ...event, at: new Date().toISOString(), pid: process.pid };
    const line = mask(JSON.stringify(entry), this.secrets());
    try {
      fs.appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
    } catch {
      // The journal explains; it must never be the reason setup stops.
    }
  }

  /** Entries written since `offset` (a byte position), and the position to read from next. */
  readFrom(offset: number): { entries: JournalEntry[]; offset: number } {
    let size: number;
    try {
      size = fs.statSync(this.file).size;
    } catch {
      return { entries: [], offset: 0 };
    }
    if (size < offset) offset = 0;
    if (size === offset) return { entries: [], offset };
    const buffer = Buffer.alloc(size - offset);
    const fd = fs.openSync(this.file, "r");
    try {
      fs.readSync(fd, buffer, 0, buffer.length, offset);
    } finally {
      fs.closeSync(fd);
    }
    // A line still being written has no newline yet; it is read next time.
    const text = buffer.toString("utf8");
    const complete = text.lastIndexOf("\n") + 1;
    return {
      entries: parseLines(text.slice(0, complete)),
      offset: offset + Buffer.byteLength(text.slice(0, complete)),
    };
  }

  readAll(): JournalEntry[] {
    return this.readFrom(0).entries;
  }
}

function parseLines(text: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // A damaged line is skipped rather than hiding everything after it.
    }
  }
  return entries;
}
