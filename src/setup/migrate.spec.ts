import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MANAGER_ENV_FILE, READY_MARKER, WALLET_ENV_FILE } from "./config-writer";
import { cleanupLegacy, runAll, SCRUBS, type MigrationDirs } from "./migrate";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dpm-migrate-"));
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

function volumes(): MigrationDirs {
  return { legacy: tempDir(), wallet: tempDir(), manager: tempDir(), state: tempDir() };
}

function legacyInstall(dirs: MigrationDirs, finished = true): void {
  fs.writeFileSync(path.join(dirs.legacy, WALLET_ENV_FILE), "A='1'\n", { mode: 0o644 });
  fs.writeFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), "B='2'\n", { mode: 0o644 });
  fs.writeFileSync(path.join(dirs.legacy, "setup-state.json"), '{"completedSteps":[]}', {
    mode: 0o600,
  });
  fs.writeFileSync(path.join(dirs.legacy, "setup-journal.jsonl"), "{}\n");
  if (finished) fs.writeFileSync(path.join(dirs.legacy, READY_MARKER), "");
}

describe("setup migrate", () => {
  it("does nothing on a fresh install", () => {
    const dirs = volumes();
    runAll(dirs, () => undefined);
    expect(fs.readdirSync(dirs.wallet)).toEqual([]);
    expect(fs.readdirSync(dirs.state)).toEqual([]);
  });

  it("splits the old config volume, each file owner-only, and leaves the old volume intact", () => {
    const dirs = volumes();
    legacyInstall(dirs);
    runAll(dirs, () => undefined);

    expect(fs.readdirSync(dirs.wallet).sort()).toEqual([READY_MARKER, WALLET_ENV_FILE].sort());
    expect(fs.readdirSync(dirs.manager).sort()).toEqual([MANAGER_ENV_FILE, READY_MARKER].sort());
    expect(fs.readFileSync(path.join(dirs.wallet, WALLET_ENV_FILE), "utf8")).toBe("A='1'\n");
    expect(fs.readdirSync(dirs.state).sort()).toEqual(
      [".legacy-migrated", "setup-journal.jsonl", "setup-state.json"].sort(),
    );
    expect(modeOf(path.join(dirs.wallet, WALLET_ENV_FILE))).toBe(0o600);
    expect(modeOf(path.join(dirs.manager, MANAGER_ENV_FILE))).toBe(0o600);
    expect(modeOf(path.join(dirs.state, "setup-state.json"))).toBe(0o600);
    expect(modeOf(dirs.state)).toBe(0o700);
    expect(fs.readdirSync(dirs.legacy)).toHaveLength(5);
  });

  it("copies no ready marker for a setup that never finished", () => {
    const dirs = volumes();
    legacyInstall(dirs, false);
    runAll(dirs, () => undefined);
    expect(fs.existsSync(path.join(dirs.wallet, READY_MARKER))).toBe(false);
    expect(fs.existsSync(path.join(dirs.manager, READY_MARKER))).toBe(false);
  });

  it("is idempotent: a second run leaves later changes alone", () => {
    const dirs = volumes();
    legacyInstall(dirs);
    runAll(dirs, () => undefined);
    fs.writeFileSync(path.join(dirs.state, "setup-state.json"), '{"completedSteps":["x"]}');
    const lines: string[] = [];
    runAll(dirs, (line) => lines.push(line));
    expect(fs.readFileSync(path.join(dirs.state, "setup-state.json"), "utf8")).toContain('"x"');
    expect(lines.join("\n")).toContain("already migrated");
  });

  it("copies again when an older version wrote to the legacy volume after a rollback", () => {
    const dirs = volumes();
    legacyInstall(dirs);
    runAll(dirs, () => undefined);
    fs.writeFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), "B='rolled-back'\n");
    const lines: string[] = [];
    runAll(dirs, (line) => lines.push(line));
    expect(fs.readFileSync(path.join(dirs.manager, MANAGER_ENV_FILE), "utf8")).toBe(
      "B='rolled-back'\n",
    );
    expect(lines.join("\n")).toContain("copied");
    runAll(dirs, (line) => lines.push(line));
    expect(lines.at(-1)).toContain("already migrated");
  });

  it("runs scrubs on the current volumes and on the legacy one, without forcing a re-copy", () => {
    const dirs = volumes();
    legacyInstall(dirs);
    const seen: string[] = [];
    (SCRUBS as unknown as unknown[]).push({
      name: "test-scrub",
      run: (layout: { manager: string }) => {
        seen.push(layout.manager);
        const file = path.join(layout.manager, MANAGER_ENV_FILE);
        if (fs.existsSync(file)) fs.writeFileSync(file, "B='scrubbed'\n");
      },
    });
    try {
      runAll(dirs, () => undefined);
      expect(seen).toEqual([dirs.manager, dirs.legacy]);
      expect(fs.readFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), "utf8")).toBe(
        "B='scrubbed'\n",
      );
      const lines: string[] = [];
      runAll(dirs, (line) => lines.push(line));
      expect(lines.join("\n")).toContain("already migrated");
    } finally {
      (SCRUBS as unknown as unknown[]).pop();
    }
  });

  it("cleanup-legacy empties the old volume", () => {
    const dirs = volumes();
    legacyInstall(dirs);
    cleanupLegacy(dirs.legacy, () => undefined);
    expect(fs.readdirSync(dirs.legacy)).toEqual([]);
  });
});
