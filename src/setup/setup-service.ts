import crypto from "node:crypto";

import { findEnvironment, resolveDpmApiUrl, type EnvironmentId } from "./environments";
import {
  fetchInstallConfig,
  probePlatform,
  SetupError,
  type FetchLike,
  type InstallConfig,
} from "./platform-config";
import { dropSetupKeys } from "./key-lifecycle";
import { generateInstallSecrets } from "./secrets";
import type { CustodyMode, SetupState } from "./state";
import { isComplete, progress, type ProvisioningDeps, type StepProgress } from "./steps";

export type PlatformInput = { environment: string; customUrl?: string };
export type KeyCheckInput = PlatformInput & { builderKey: string };
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
  /** Whether the admin UI has an owner yet; until it has, the page asks for one. */
  ownerCreated: boolean;
};

const MODES: readonly CustodyMode[] = ["shared", "segregated"];

/** Mirrors the wallet manager's own rule, so the common mistake is caught before the call. */
const MIN_OWNER_PASSWORD = 12;

/** The manager's refusal, in words: it answers `{ error: { code, message } }`. */
function ownerRefusal(status: number, body: unknown): string {
  const error = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  if (error?.code === "USERNAME_TAKEN") return "That username is already taken; choose another.";
  if (error?.code === "VALIDATION_FAILED") {
    return "Use 3-64 letters, digits, '.', '_', '-' or '@' for the username, and at least 12 characters for the password.";
  }
  return `The wallet manager refused (${status}): ${error?.message ?? "unknown error"}`;
}

/**
 * The setup flow, shared by the dashboard and the plain terminal: check a platform and a key,
 * record the answers, ask for a retry, and hand over the backup kit. Provisioning itself runs in
 * the worker (worker.ts), which picks the answers up; neither front end holds logic of its own.
 */
export class SetupService {
  constructor(
    private readonly deps: ProvisioningDeps,
    private readonly fetchImpl: FetchLike = fetch,
    /** Where the admin UI is reached from outside the stack, for the backup kit. */
    private readonly adminUiUrl?: string,
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
      ownerCreated: state.ownerCreated,
    };
  }

  /**
   * Notices an owner that already exists — an install set up before the admin UI, whose owner was
   * then created another way — so the page does not ask for a second one. Quiet on failure: the
   * worst case is offering a form whose submission the manager then refuses.
   */
  async refreshOwnerStatus(): Promise<void> {
    const state = this.deps.store.load();
    if (state.ownerCreated || !isComplete(state) || !state.secrets?.adminKey) return;
    const listed = await this.deps
      .http("GET", `${this.deps.managerUrl}/v1/ui-users`, { apiKey: state.secrets.adminKey })
      .catch(() => undefined);
    const users = (listed?.status === 200 ? (listed.body as { items?: unknown }).items : []) as
      Array<{ role?: string; status?: string }> | undefined;
    if (!users?.some((user) => user.role === "owner" && user.status === "active")) return;
    this.deps.store.update((next) => {
      next.ownerCreated = true;
    });
    this.remember();
    dropSetupKeys(this.deps.store);
  }

  /**
   * Creates the admin UI's first owner through the wallet manager's own API, with the admin key
   * setup holds. The password is passed straight through and never stored here.
   */
  async createOwner(username: string, password: string): Promise<void> {
    const state = this.deps.store.load();
    if (!isComplete(state) || !state.secrets) throw new SetupError("Finish setup first.");
    if (state.ownerCreated) throw new SetupError("The owner account already exists.");
    if (!state.secrets.adminKey) {
      throw new SetupError("The admin key is no longer stored, so setup cannot create the owner.");
    }
    if (password.length < MIN_OWNER_PASSWORD) {
      throw new SetupError(`The password needs at least ${MIN_OWNER_PASSWORD} characters.`);
    }
    const created = await this.deps.http("POST", `${this.deps.managerUrl}/v1/ui-users`, {
      apiKey: state.secrets.adminKey,
      body: { username: username.trim(), password, role: "owner" },
    });
    if (created.status !== 201) throw new SetupError(ownerRefusal(created.status, created.body));
    this.deps.store.update((next) => {
      next.ownerCreated = true;
    });
    this.remember();
    dropSetupKeys(this.deps.store);
  }

  /** Checks the platform answers at the chosen address, before a key is asked for. */
  async checkPlatform(input: PlatformInput): Promise<string> {
    const dpmApiUrl = this.platformUrl(input);
    await probePlatform(dpmApiUrl, this.fetchImpl);
    return dpmApiUrl;
  }

  async checkKey(input: KeyCheckInput): Promise<KeyCheckResult> {
    const environment = findEnvironment(input.environment);
    if (!environment) throw new SetupError("Choose an environment.");
    const dpmApiUrl = this.platformUrl(input);
    const platform = await fetchInstallConfig(dpmApiUrl, input.builderKey, this.fetchImpl);
    return { environment: environment.id, dpmApiUrl, platform };
  }

  /**
   * Checks the key once more and fixes every answer and secret; the worker then starts
   * provisioning. Only the first start is accepted: after it the mode is burned in, so a second
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
      state.installId = crypto.randomBytes(4).toString("hex");
    });
  }

  /** Asks the worker to run the remaining steps again, after a failure. */
  retry(): void {
    const state = this.deps.store.load();
    if (!state.answers || isComplete(state) || !state.lastError) return;
    this.deps.store.requestRetry();
  }

  /** A retry asked for and not yet picked up: the last failure no longer stands. */
  retryPending(): boolean {
    return this.deps.store.retryRequested();
  }

  state(): SetupState {
    return this.deps.store.load();
  }

  acknowledgeBackup(): void {
    this.deps.store.update((state) => {
      state.backupAcknowledged = true;
      // Shown once in the kit; from here on only the public half stays on this machine.
      if (state.secrets) delete state.secrets.backupRecoveryKey;
    });
    this.remember();
    dropSetupKeys(this.deps.store);
  }

  backupKit(): string {
    return renderBackupKit(this.deps.store.load(), this.adminUiUrl);
  }

  /** The URL and key the builder's own backend is configured with, once setup is done. */
  connectionDetails(): { operatorKey: string } | undefined {
    const state = this.deps.store.load();
    if (!isComplete(state)) return undefined;
    this.remember();
    return this.operatorKey ? { operatorKey: this.operatorKey } : undefined;
  }

  /**
   * The backend key as of this session. Setup drops it from its state once the owner has the kit,
   * but the screen that ends the session still shows it; from a later session it is revealed in
   * the admin UI instead.
   */
  private operatorKey: string | undefined;
  private remember(): void {
    this.operatorKey ??= this.deps.store.load().operatorKey;
  }

  private platformUrl(input: PlatformInput): string {
    const environment = findEnvironment(input.environment);
    if (!environment) throw new SetupError("Choose an environment.");
    const dpmApiUrl = resolveDpmApiUrl(environment, input.customUrl);
    if (typeof dpmApiUrl !== "string") throw new SetupError(dpmApiUrl.error);
    return dpmApiUrl;
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
export function renderBackupKit(state: SetupState, adminUiUrl?: string): string {
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
    ...(adminUiUrl ? [`Admin UI:           ${adminUiUrl} (sign in with your owner account)`] : []),
    "",
    "-- Secrets --",
    `Wallet encryption key:   ${state.secrets.walletEncryptionKey}`,
    `Manager master key:      ${state.secrets.managerMasterKey}`,
    ...(state.secrets.adminKey
      ? [
          `Admin API key:           ${state.secrets.adminKey}`,
          `Backend (operator) key:  ${state.operatorKey ?? "(not issued yet)"}`,
        ]
      : [
          "Admin and backend API keys: not kept by setup any more. Sign in to the admin UI and",
          "                            reveal them under API keys.",
        ]),
    `Internal wallet API key: ${state.secrets.walletApiKey}`,
    ...(state.answers.builderKey
      ? [`Builder private key:     ${state.answers.builderKey}`]
      : ["Builder private key:     not kept by setup; it is in the platform backoffice."]),
    "",
    ...recoveryKeyLines(state.secrets),
    "Also back up the data itself: run ./dpm-custody backup regularly.",
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * Backups are encrypted to a key whose private half is shown here once and then forgotten, so
 * the machine that writes them cannot read them. Without it a backup cannot be opened.
 */
function recoveryKeyLines(secrets: SetupState["secrets"]): string[] {
  if (secrets?.backupRecoveryKey) {
    return [
      "-- Backup recovery key (shown once; this machine does not keep it) --",
      `Backup recovery key:     ${secrets.backupRecoveryKey}`,
      "Backups are encrypted so that only this key opens them. Store it with the secrets above.",
      "If it is lost, the backups cannot be read. This kit will not show it again.",
      "",
    ];
  }
  if (secrets?.backupRecipient) {
    return [
      "-- Backup recovery key --",
      "It was shown once, when setup finished, and is not stored on this machine.",
      "",
    ];
  }
  return [
    "-- Backups are not encrypted yet --",
    "Run ./dpm-custody backup-key to create a recovery key; later backups are then encrypted.",
    "",
  ];
}
