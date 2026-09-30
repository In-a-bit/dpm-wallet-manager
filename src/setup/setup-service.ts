import { findEnvironment, resolveDpmApiUrl, type EnvironmentId } from "./environments";
import {
  fetchInstallConfig,
  SetupError,
  type FetchLike,
  type InstallConfig,
} from "./platform-config";
import { generateInstallSecrets } from "./secrets";
import type { CustodyMode, SetupState } from "./state";
import { isComplete, progress, provision, type ProvisioningDeps, type StepProgress } from "./steps";

export type KeyCheckInput = { environment: string; customUrl?: string; builderKey: string };
export type StartInput = KeyCheckInput & { mode: string; confirmModeIsPermanent: boolean };

export type KeyCheckResult = {
  environment: EnvironmentId;
  dpmApiUrl: string;
  platform: InstallConfig;
};

/** What the page shows. Carries no secret: those leave only through the backup kit. */
export type SetupView = {
  phase: "new" | "running" | "failed" | "done";
  builderName?: string;
  environment?: EnvironmentId;
  mode?: CustodyMode;
  steps: StepProgress[];
  lastError?: string;
  backupAcknowledged: boolean;
};

const MODES: readonly CustodyMode[] = ["shared", "segregated"];

/**
 * The setup flow, shared by the browser page and the terminal: check a key, start, retry, and hand
 * over the backup kit. Neither front end holds any logic of its own.
 */
export class SetupService {
  private active?: Promise<SetupState>;

  constructor(
    private readonly deps: ProvisioningDeps,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  view(): SetupView {
    const state = this.deps.store.load();
    return {
      phase: phaseOf(state),
      builderName: state.platform?.owner.name,
      environment: state.answers?.environment,
      mode: state.answers?.mode,
      steps: progress(state),
      lastError: state.lastError,
      backupAcknowledged: state.backupAcknowledged,
    };
  }

  async checkKey(input: KeyCheckInput): Promise<KeyCheckResult> {
    const environment = findEnvironment(input.environment);
    if (!environment) throw new SetupError("Choose an environment.");
    const dpmApiUrl = resolveDpmApiUrl(environment, input.customUrl);
    if (typeof dpmApiUrl !== "string") throw new SetupError(dpmApiUrl.error);
    const platform = await fetchInstallConfig(dpmApiUrl, input.builderKey, this.fetchImpl);
    return { environment: environment.id, dpmApiUrl, platform };
  }

  /**
   * Checks the key once more, fixes every answer and secret, and starts provisioning in the
   * background. Only the first start is accepted: after it the mode is burned in, so a second
   * set of answers would describe an install that does not exist.
   */
  async start(input: StartInput): Promise<void> {
    if (this.deps.store.load().answers) throw new SetupError("Setup has already been started.");
    const mode = parseMode(input);
    const checked = await this.checkKey(input);
    const keyEnv = findEnvironment(checked.environment)?.keyEnv ?? checked.environment;
    this.deps.store.update((state) => {
      state.answers = {
        environment: checked.environment,
        dpmApiUrl: checked.dpmApiUrl,
        builderKey: input.builderKey.trim(),
        mode,
      };
      state.platform = checked.platform;
      state.secrets = generateInstallSecrets(keyEnv);
    });
    this.runInBackground();
  }

  /** Resumes after a failure or a restart. A no-op while a run is already in progress. */
  resume(): void {
    const state = this.deps.store.load();
    if (!state.answers || isComplete(state)) return;
    this.runInBackground();
  }

  /** Runs to completion in the caller's flow; the terminal uses this. */
  async runToCompletion(): Promise<SetupState> {
    this.runInBackground();
    return this.active as Promise<SetupState>;
  }

  acknowledgeBackup(): void {
    this.deps.store.update((state) => {
      state.backupAcknowledged = true;
    });
  }

  backupKit(): string {
    return renderBackupKit(this.deps.store.load());
  }

  /** The URL and key the builder's own backend is configured with, once setup is done. */
  connectionDetails(): { operatorKey: string } | undefined {
    const state = this.deps.store.load();
    if (!isComplete(state) || !state.operatorKey) return undefined;
    return { operatorKey: state.operatorKey };
  }

  private runInBackground(): void {
    if (this.active) return;
    this.active = provision(this.deps).finally(() => {
      this.active = undefined;
    });
    // The page polls the state for the outcome; a failure is already recorded there.
    this.active.catch(() => undefined);
  }
}

function phaseOf(state: SetupState): SetupView["phase"] {
  if (!state.answers) return "new";
  if (isComplete(state)) return "done";
  if (state.running) return "running";
  return state.lastError ? "failed" : "running";
}

function parseMode(input: StartInput): CustodyMode {
  const mode = MODES.find((candidate) => candidate === input.mode);
  if (!mode) throw new SetupError("Choose how user funds are held.");
  if (!input.confirmModeIsPermanent) {
    throw new SetupError("Confirm that you understand this choice cannot be changed later.");
  }
  return mode;
}

/**
 * Everything needed to recover the install on another machine, and nothing that can be looked up
 * again. Plain text on purpose: it must open anywhere, years from now.
 */
export function renderBackupKit(state: SetupState): string {
  if (!state.answers || !state.secrets || !state.platform) {
    throw new SetupError("There is nothing to back up until setup has started.");
  }
  const lines = [
    "DPM custody install - backup kit",
    "Keep this file somewhere safe and private (a password manager is ideal).",
    "Anyone who has it can control this install. Without it, a lost machine cannot be recovered.",
    "",
    `Builder:            ${state.platform.owner.name} (id ${state.platform.owner.id})`,
    `Environment:        ${state.answers.environment} (${state.answers.dpmApiUrl})`,
    `Custody mode:       ${state.answers.mode}`,
    "",
    "-- Secrets --",
    `Wallet encryption key:   ${state.secrets.walletEncryptionKey}`,
    `Manager master key:      ${state.secrets.managerMasterKey}`,
    `Admin API key:           ${state.secrets.adminKey}`,
    `Backend (operator) key:  ${state.operatorKey ?? "(not issued yet)"}`,
    `Internal wallet API key: ${state.secrets.walletApiKey}`,
    `Builder private key:     ${state.answers.builderKey}`,
    "",
    "Also back up the data itself: run ./dpm-custody backup regularly.",
  ];
  return `${lines.join("\n")}\n`;
}
