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
  builderKey: string;
  mode: CustodyMode;
};

/**
 * Everything setup knows, persisted after every change so a closed tab, a crash or a reboot
 * resumes where it stopped. It lives on the same volume as the env files it produces, which
 * already hold these secrets, so keeping it adds no new exposure.
 */
export type SetupState = {
  answers?: SetupAnswers;
  platform?: InstallConfig;
  secrets?: InstallSecrets;
  operatorKey?: string;
  completedSteps: string[];
  running: boolean;
  lastError?: string;
  backupAcknowledged: boolean;
};

const STATE_FILE = "setup-state.json";
const OWNER_ONLY = 0o600;

export function emptyState(): SetupState {
  return { completedSteps: [], running: false, backupAcknowledged: false };
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

  private file(): string {
    return path.join(this.configDir, STATE_FILE);
  }
}

export function isProvisioned(state: SetupState, allSteps: readonly string[]): boolean {
  return allSteps.every((step) => state.completedSteps.includes(step));
}
