import fs from "node:fs";
import path from "node:path";

import type { EnvironmentId } from "./environments";
import type { InstallConfig } from "./platform-config";
import type { InstallSecrets } from "./secrets";

export type CustodyMode = "shared" | "segregated";

/** What the person chose. Fixed once provisioning starts: the mode is burned into the database. */
export type SetupAnswers = {
  environment: EnvironmentId;
  dpmApiUrl: string;
  /** Dropped once setup is finished and the owner has the kit (key-lifecycle.ts). */
  builderKey?: string;
  mode: CustodyMode;
};

/**
 * Everything setup knows, persisted after every change so a closed tab, a crash or a reboot
 * resumes where it stopped. It lives in the setup-state volume, mounted by setup alone, so the
 * services never see the secrets of the other one (or the owner-visible kit material).
 */
export type SetupState = {
  answers?: SetupAnswers;
  /** A short random reference for this install, quoted to support; not a secret. */
  installId?: string;
  platform?: InstallConfig;
  secrets?: InstallSecrets;
  operatorKey?: string;
  completedSteps: string[];
  running: boolean;
  lastError?: string;
  backupAcknowledged: boolean;
  /**
   * Whether the admin UI has an owner account. Only the fact is kept: the password goes straight
   * to the wallet manager and is never written here.
   */
  ownerCreated: boolean;
};

const STATE_FILE = "setup-state.json";
/**
 * A retry is asked for through its own file rather than the state, which the worker may be
 * saving at the same moment: two writers of one file would lose each other's changes.
 */
const RETRY_FILE = "retry-requested";
const OWNER_ONLY = 0o600;

export function emptyState(): SetupState {
  return { completedSteps: [], running: false, backupAcknowledged: false, ownerCreated: false };
}

export class SetupStateStore {
  constructor(private readonly configDir: string) {}

  load(): SetupState {
    const file = this.file();
    if (!fs.existsSync(file)) return emptyState();
    return { ...emptyState(), ...(JSON.parse(fs.readFileSync(file, "utf8")) as SetupState) };
  }

  /** Write-then-rename, so a crash mid-write never leaves a half file to resume from. */
  save(state: SetupState): void {
    const temp = `${this.file()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: OWNER_ONLY });
    fs.renameSync(temp, this.file());
  }

  update(change: (state: SetupState) => void): SetupState {
    const state = this.load();
    change(state);
    this.save(state);
    return state;
  }

  /** Asks the worker to run the remaining steps again after a failure. */
  requestRetry(): void {
    fs.writeFileSync(path.join(this.configDir, RETRY_FILE), new Date().toISOString(), {
      mode: OWNER_ONLY,
    });
  }

  retryRequested(): boolean {
    return fs.existsSync(path.join(this.configDir, RETRY_FILE));
  }

  clearRetryRequest(): void {
    fs.rmSync(path.join(this.configDir, RETRY_FILE), { force: true });
  }

  private file(): string {
    return path.join(this.configDir, STATE_FILE);
  }
}

export function isProvisioned(state: SetupState, allSteps: readonly string[]): boolean {
  return allSteps.every((step) => state.completedSteps.includes(step));
}
