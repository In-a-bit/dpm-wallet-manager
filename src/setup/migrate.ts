import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { MANAGER_ENV_FILE, READY_MARKER, WALLET_ENV_FILE } from "./config-writer";

/**
 * `setup migrate`: brings an install's volumes up to the layout this version expects. It runs
 * before the services start (dpm-custody upgrade, and the `migrate` service every `up` waits for),
 * so every step is idempotent and a fresh install passes through it doing nothing.
 *
 * To add a step, append to MIGRATIONS. Steps run in order; one that throws stops the rest and the
 * services do not start until it is fixed.
 */
export type MigrationDirs = {
  /** The single `config` volume of earlier versions. Never modified by a migration. */
  legacy: string;
  wallet: string;
  manager: string;
  state: string;
  /** False when the legacy volume is mounted read-only; unset means "check the directory". */
  legacyWritable?: boolean;
};

type Migration = { name: string; run: (dirs: MigrationDirs, say: (line: string) => void) => void };

export const MIGRATIONS: readonly Migration[] = [
  { name: "split-config-volumes", run: splitConfigVolumes },
];

export function runMigrations(dirs: MigrationDirs, say: (line: string) => void): void {
  for (const migration of MIGRATIONS) {
    say(`[migrate] ${migration.name}`);
    migration.run(dirs, (line) => say(`[migrate]   ${line}`));
  }
}

/**
 * Written to the state volume once everything is copied. It holds a fingerprint of the legacy
 * volume as it was then, so a rollback that lets an older version write there again is noticed
 * and copied again on the next upgrade.
 */
const DONE_MARKER = ".legacy-migrated";
const OWNER_ONLY = 0o600;

/** The three places a configuration lives; the legacy volume holds all of them in one folder. */
export type ConfigLayout = { wallet: string; manager: string; state: string };

/**
 * Scrubs run after the migrations, on the current volumes and on the legacy one, on every
 * `setup migrate`. A task that removes a secret from the configuration appends a scrub here, so
 * the copy a rollback would restore is cleaned too. Each must be idempotent. Setup mounts the
 * legacy volume read-only, so its own start skips the legacy half; `dpm-custody upgrade` runs
 * migrate with the volume writable, which is where legacy gets scrubbed.
 */
type Scrub = { name: string; run: (layout: ConfigLayout, say: (line: string) => void) => void };
export const SCRUBS: readonly Scrub[] = [];

/** The migrations, then the scrubs, then the legacy fingerprint (last, so a crash re-copies). */
export function runAll(dirs: MigrationDirs, say: (line: string) => void): void {
  runMigrations(dirs, say);
  const legacy: ConfigLayout = { wallet: dirs.legacy, manager: dirs.legacy, state: dirs.legacy };
  const legacyWritable = dirs.legacyWritable ?? isWritable(dirs.legacy);
  for (const scrub of SCRUBS) {
    say(`[migrate] scrub ${scrub.name}`);
    scrub.run(dirs, (line) => say(`[migrate]   ${line}`));
    if (legacyWritable) scrub.run(legacy, (line) => say(`[migrate]   legacy: ${line}`));
    else say("[migrate]   legacy: read-only here, left for the upgrade's writable run");
  }
  sealLegacy(dirs);
}

function isWritable(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function sealLegacy(dirs: MigrationDirs): void {
  if (listFiles(dirs.legacy).length === 0) return;
  fs.writeFileSync(path.join(dirs.state, DONE_MARKER), legacyFingerprint(dirs.legacy), {
    mode: OWNER_ONLY,
  });
}

/** sha256 over the names and contents of the legacy volume. */
function legacyFingerprint(dir: string): string {
  const hash = createHash("sha256");
  for (const name of listFiles(dir).sort()) {
    hash
      .update(`${name}\0`)
      .update(fs.readFileSync(path.join(dir, name)))
      .update("\0");
  }
  return hash.digest("hex");
}

/**
 * Copies the old single `config` volume into the three new ones: each service's env file and
 * `ready` go to its own volume, everything else (setup's state, journal, retry request) to the
 * setup-state volume. The old volume is left as it is: a rollback needs it. A legacy volume that
 * has not changed since the last copy is skipped; one an older version wrote to since (after a
 * rollback) is copied again.
 */
function splitConfigVolumes(dirs: MigrationDirs, say: (line: string) => void): void {
  const legacy = listFiles(dirs.legacy);
  if (legacy.length === 0) return say("nothing to migrate");
  const marker = path.join(dirs.state, DONE_MARKER);
  if (fs.existsSync(marker) && fs.readFileSync(marker, "utf8") === legacyFingerprint(dirs.legacy)) {
    return say("already migrated");
  }

  const services: [string, string][] = [
    [WALLET_ENV_FILE, dirs.wallet],
    [MANAGER_ENV_FILE, dirs.manager],
  ];
  const own = new Set([...services.map(([file]) => file), READY_MARKER]);
  fs.chmodSync(dirs.state, 0o700);
  for (const file of legacy.filter((name) => !own.has(name))) copy(dirs.legacy, file, dirs.state);
  for (const [file, dir] of services) {
    if (legacy.includes(file)) copy(dirs.legacy, file, dir);
  }
  // `ready` last, and only where its env file arrived: a service must never see ready without it.
  if (legacy.includes(READY_MARKER)) {
    for (const [file, dir] of services) {
      if (legacy.includes(file)) copy(dirs.legacy, READY_MARKER, dir);
    }
  }
  say(`copied ${legacy.length} file(s); the old config volume is kept until cleanup-legacy`);
}

/** Empties the old `config` volume, after an upgrade has proved itself. */
export function cleanupLegacy(legacyDir: string, say: (line: string) => void): void {
  const files = listFiles(legacyDir);
  for (const file of files) fs.rmSync(path.join(legacyDir, file), { recursive: true, force: true });
  say(
    files.length === 0
      ? "The old config volume is already empty."
      : `Removed ${files.length} item(s) from the old config volume.`,
  );
}

function listFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}

function copy(fromDir: string, file: string, toDir: string): void {
  const target = path.join(toDir, file);
  fs.copyFileSync(path.join(fromDir, file), target);
  fs.chmodSync(target, file === READY_MARKER ? 0o644 : OWNER_ONLY);
}
