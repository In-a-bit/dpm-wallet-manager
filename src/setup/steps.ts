import type { DatabaseCredentials, InstallInputs } from "./config-writer";
import { findEnvironment } from "./environments";
import type { JournalEvent } from "./journal";
import { SetupError } from "./platform-config";
import { withDbPasswords, type InstallSecrets } from "./secrets";
import type { SetupState, SetupStateStore } from "./state";

/** The one header both services authenticate their callers by. */
export const API_KEY_HEADER = "X-API-Key";

export type HttpResult = { status: number; body: unknown };

/** The seam tests replace. `apiKey` goes in X-API-Key; `body` is sent as JSON. */
export type SetupHttp = (
  method: "GET" | "POST",
  url: string,
  options?: { apiKey?: string; body?: unknown },
) => Promise<HttpResult>;

export type ProvisioningDeps = {
  http: SetupHttp;
  store: SetupStateStore;
  writeConfig: (inputs: InstallInputs) => void;
  /** Takes the bootstrap admin key out of the manager's settings once the manager has adopted it. */
  dropBootstrapKey: () => void;
  /** Creates the services' database roles (db-roles.ts); the superuser connection stays here. */
  provisionDbRoles: (secrets: InstallSecrets) => Promise<void>;
  sleep: (ms: number) => Promise<void>;
  walletUrl: string;
  managerUrl: string;
  database: DatabaseCredentials;
  /** How long a service may take to come up; the first start runs its migrations. */
  readyTimeoutMs: number;
  /** Where each step says what it is doing; the journal, outside tests. */
  report?: (event: JournalEvent) => void;
};

type StepContext = {
  deps: ProvisioningDeps;
  state: SetupState;
  progress: (message: string) => void;
};

/** A change a step makes to the state, applied in the same save that marks it done. */
type StateChange = (state: SetupState) => void;

type Step = {
  id: string;
  label: string;
  appliesTo: (state: SetupState) => boolean;
  run: (ctx: StepContext) => Promise<StateChange | void>;
};

export type StepProgress = {
  id: string;
  label: string;
  status: "done" | "running" | "failed" | "pending" | "skipped";
};

const always = () => true;
const POLL_INTERVAL_MS = 2_000;

/**
 * The order matters and every step is safe to repeat: the wallet cannot initialise its vault
 * before it runs, the manager's wallets are created through the wallet, and each call here is
 * idempotent upstream (vault init reuses its key pair; the platform wallets are created once).
 */
export const STEPS: readonly Step[] = [
  { id: "write-config", label: "Save the configuration", appliesTo: always, run: writeConfig },
  { id: "wallet-ready", label: "Start the wallet service", appliesTo: always, run: waitForWallet },
  { id: "vault-init", label: "Create the secure key vault", appliesTo: always, run: initVault },
  {
    id: "manager-ready",
    label: "Start the wallet manager",
    appliesTo: always,
    run: waitForManager,
  },
  {
    id: "master-wallet",
    label: "Create the master wallet",
    appliesTo: always,
    run: createMasterWallet,
  },
  {
    // Both modes: in shared it makes every trade; in segregated it never trades, but it is the pot
    // users' wallets are funded from and the one they move funds back to.
    id: "operations-wallet",
    label: "Create the operations wallet",
    appliesTo: always,
    run: createOperationsWallet,
  },
  {
    id: "operator-key",
    label: "Issue the key for your backend",
    appliesTo: always,
    run: issueOperatorKey,
  },
  { id: "verify", label: "Check everything works", appliesTo: always, run: verify },
];

export function progress(state: SetupState): StepProgress[] {
  const current = STEPS.find(
    (step) => step.appliesTo(state) && !state.completedSteps.includes(step.id),
  );
  return STEPS.map((step) => ({
    id: step.id,
    label: step.label,
    status: stepStatus(state, step, current),
  }));
}

function stepStatus(
  state: SetupState,
  step: Step,
  current: Step | undefined,
): StepProgress["status"] {
  if (!step.appliesTo(state)) return "skipped";
  if (state.completedSteps.includes(step.id)) return "done";
  if (step !== current) return "pending";
  if (state.running) return "running";
  return state.lastError ? "failed" : "pending";
}

export function isComplete(state: SetupState): boolean {
  return STEPS.every((step) => !step.appliesTo(state) || state.completedSteps.includes(step.id));
}

/**
 * Runs every step not yet done, saving after each. Called again after any interruption, it picks
 * up at the first unfinished step. A failure is recorded for the page and rethrown.
 */
export async function provision(deps: ProvisioningDeps): Promise<SetupState> {
  deps.store.update((state) => {
    state.running = true;
    delete state.lastError;
  });
  try {
    for (const step of STEPS) await runStep(step, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.store.update((state) => {
      state.running = false;
      state.lastError = message;
    });
    throw err;
  }
  return deps.store.update((state) => {
    state.running = false;
  });
}

async function runStep(step: Step, deps: ProvisioningDeps): Promise<void> {
  const state = deps.store.load();
  if (!step.appliesTo(state) || state.completedSteps.includes(step.id)) return;
  const report = deps.report ?? (() => undefined);
  const started = Date.now();
  report({ type: "step.start", step: step.id });
  const progress = (message: string) => report({ type: "step.progress", step: step.id, message });
  let change: StateChange | void;
  try {
    change = await step.run({ deps, state, progress });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    report({ type: "step.fail", step: step.id, ms: Date.now() - started, error });
    throw err;
  }
  deps.store.update((next) => {
    if (change) change(next);
    next.completedSteps.push(step.id);
  });
  report({ type: "step.done", step: step.id, ms: Date.now() - started });
}

// ── steps ───────────────────────────────────────────────────────────────────

async function writeConfig({ deps, state, progress }: StepContext): Promise<StateChange> {
  const { answers, platform, secrets: saved } = requireConfigured(state);
  // Each service gets a database role of its own; the superuser is never written to them.
  const secrets = withDbPasswords(saved);
  progress("Creating a limited database account for each service");
  await deps.provisionDbRoles(secrets);
  progress("Writing the settings files for the wallet service and the wallet manager");
  const keyEnv = findEnvironment(answers.environment)?.keyEnv ?? answers.environment;
  deps.writeConfig({ answers, platform, secrets, database: deps.database, keyEnv });
  return (next) => {
    next.secrets = secrets;
  };
}

async function waitForWallet({ deps, progress }: StepContext): Promise<void> {
  await waitUntilHealthy(deps, `${deps.walletUrl}/v1/health`, "The wallet service", progress);
}

async function initVault({ deps, state, progress }: StepContext): Promise<void> {
  const { secrets } = requireConfigured(state);
  progress("Asking the wallet service to create its vault with the key provider");
  const result = await deps.http("POST", `${deps.walletUrl}/v1/vault/init`, {
    apiKey: secrets.walletApiKey,
  });
  expectSuccess(result, "Creating the key vault");
}

async function waitForManager({ deps, progress }: StepContext): Promise<void> {
  await waitUntilHealthy(deps, `${deps.managerUrl}/v1/health`, "The wallet manager", progress);
}

async function createMasterWallet({ deps, state, progress }: StepContext): Promise<void> {
  progress("Creating the master wallet, then registering it with the platform");
  await postAsAdmin(deps, state, "/v1/platform/master-wallet", {}, "Creating the master wallet");
  // This call signed in with the admin key, so the manager has adopted it: its settings no longer
  // need to carry it.
  deps.dropBootstrapKey();
}

async function createOperationsWallet({ deps, state, progress }: StepContext): Promise<void> {
  progress("Creating the operations wallet, then registering it with the platform");
  await postAsAdmin(
    deps,
    state,
    "/v1/platform/operations-wallet",
    {},
    "Creating the operations wallet",
  );
}

async function issueOperatorKey({ deps, state, progress }: StepContext): Promise<StateChange> {
  progress("Asking the wallet manager for an operator key");
  const body = await postAsAdmin(
    deps,
    state,
    "/v1/api-keys",
    { role: "operator", name: "builder-backend" },
    "Issuing the backend key",
  );
  const key = (body as { key?: unknown }).key;
  if (typeof key !== "string")
    throw new SetupError("The wallet manager did not return the backend key.");
  return (next) => {
    next.operatorKey = key;
  };
}

async function verify({ deps, state, progress }: StepContext): Promise<void> {
  const { answers, secrets } = requireConfigured(state);
  progress("Reading the wallet manager's own view of the install");
  const result = await deps.http("GET", `${deps.managerUrl}/v1/platform`, {
    apiKey: adminKeyOf(secrets),
  });
  const platform = expectSuccess(result, "Checking the install") as PlatformStatus;
  const problem = platformProblem(platform, answers.mode);
  if (problem) throw new SetupError(`The install is not ready: ${problem}.`);
}

// ── helpers ─────────────────────────────────────────────────────────────────

type PlatformStatus = {
  mode?: string;
  masterWallet?: { dpmRegistered?: boolean } | null;
  operationsWallet?: { dpmRegistered?: boolean } | null;
  upstream?: { reachable?: boolean; vault?: { initialized?: boolean } };
};

function platformProblem(platform: PlatformStatus, mode: string): string | undefined {
  if (platform.mode !== mode) return `it runs in "${platform.mode}" mode, not "${mode}"`;
  if (!platform.upstream?.reachable) return "the wallet manager cannot reach the wallet service";
  if (!platform.upstream.vault?.initialized) return "the key vault is not initialised";
  if (!platform.masterWallet) return "there is no master wallet";
  if (!platform.operationsWallet) return "there is no operations wallet";
  // Unregistered, a platform wallet cannot move a cent: relayer-api relays only for addresses
  // the platform knows.
  if (!platform.masterWallet.dpmRegistered)
    return "the master wallet is not registered with the platform";
  if (!platform.operationsWallet.dpmRegistered) {
    return "the operations wallet is not registered with the platform";
  }
  return undefined;
}

function adminKeyOf(secrets: { adminKey?: string }): string {
  if (!secrets.adminKey)
    throw new SetupError("The admin key is no longer stored; setup is finished.");
  return secrets.adminKey;
}

function requireConfigured(
  state: SetupState,
): Required<Pick<SetupState, "answers" | "platform" | "secrets">> {
  if (!state.answers || !state.platform || !state.secrets) {
    throw new SetupError("Setup has not been started yet.");
  }
  return { answers: state.answers, platform: state.platform, secrets: state.secrets };
}

async function postAsAdmin(
  deps: ProvisioningDeps,
  state: SetupState,
  path: string,
  body: unknown,
  what: string,
): Promise<unknown> {
  const { secrets } = requireConfigured(state);
  const result = await deps.http("POST", `${deps.managerUrl}${path}`, {
    apiKey: adminKeyOf(secrets),
    body,
  });
  return expectSuccess(result, what);
}

function expectSuccess(result: HttpResult, what: string): unknown {
  if (result.status >= 200 && result.status < 300) return result.body;
  throw new SetupError(`${what} failed (${result.status}): ${describeError(result.body)}`);
}

/** Both services answer errors as `{ code, message }`; fall back to the raw body otherwise. */
/**
 * The services answer errors as `{ message }`, `{ error: { message } }` or `{ error: "…" }`; the
 * message is what a person can act on, so dig it out rather than show the envelope.
 */
function describeError(body: unknown): string {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return JSON.stringify(body);
  if ("message" in body && typeof body.message === "string") return body.message;
  if ("error" in body) return describeError(body.error);
  return JSON.stringify(body);
}

async function waitUntilHealthy(
  deps: ProvisioningDeps,
  url: string,
  service: string,
  progress: (message: string) => void,
): Promise<void> {
  const started = Date.now();
  const deadline = started + deps.readyTimeoutMs;
  for (let attempt = 1; Date.now() < deadline; attempt++) {
    const waited = Math.round((Date.now() - started) / 1000);
    progress(
      attempt === 1
        ? `Waiting for ${service.toLowerCase()} to answer`
        : `Still starting (check ${attempt}, ${waited}s so far; the first start prepares its database)`,
    );
    const healthy = await deps.http("GET", url).then(
      (result) => result.status === 200,
      () => false,
    );
    if (healthy) return;
    await deps.sleep(POLL_INTERVAL_MS);
  }
  throw new SetupError(
    `${service} did not start within ${Math.round(deps.readyTimeoutMs / 60_000)} minutes.`,
  );
}
