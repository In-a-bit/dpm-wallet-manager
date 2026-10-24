import fs from "node:fs";
import path from "node:path";

import { MANAGER_ENV_FILE } from "./config-writer";
import { SetupStateStore, type SetupState } from "./state";
import { STEPS } from "./steps";

/**
 * Credentials setup needs only while it sets up. Left lying around, each is a way to act as the
 * install long after: the bootstrap admin key sits in the manager's env file, and the admin,
 * backend and builder keys sit in setup's state. Both are dropped as soon as they are done with;
 * the admin and backend keys are revealed in the admin UI from then on, the builder key is the
 * builder's own (platform backoffice).
 */

const BOOTSTRAP_VAR = "DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY";
/** The first step that signs in to the manager with the admin key: after it, the key is adopted. */
const ADOPTED_AFTER = "master-wallet";

/** Setup is finished and the owner has the kit and an account: nothing is left to use the keys for. */
export function isHandedOver(state: SetupState): boolean {
  return (
    STEPS.every((step) => !step.appliesTo(state) || state.completedSteps.includes(step.id)) &&
    state.backupAcknowledged &&
    state.ownerCreated
  );
}

/** Drops the admin, backend and builder keys from setup's state once handed over. */
export function dropSetupKeys(store: SetupStateStore): boolean {
  const state = store.load();
  if (!isHandedOver(state)) return false;
  const present = Boolean(
    state.secrets?.adminKey || state.operatorKey || state.answers?.builderKey,
  );
  if (!present) return false;
  store.update((next) => {
    if (next.secrets) delete next.secrets.adminKey;
    delete next.operatorKey;
    if (next.answers) delete next.answers.builderKey;
  });
  return true;
}

/** Removes the bootstrap admin key line from the manager's env file. True when it was there. */
export function removeBootstrapKey(managerDir: string): boolean {
  const file = path.join(managerDir, MANAGER_ENV_FILE);
  if (!fs.existsSync(file)) return false;
  const text = fs.readFileSync(file, "utf8");
  const kept = text.split("\n").filter((line) => !line.startsWith(`${BOOTSTRAP_VAR}=`));
  if (kept.length === text.split("\n").length) return false;
  const mode = fs.statSync(file).mode & 0o777;
  fs.writeFileSync(file, kept.join("\n"), { mode });
  fs.chmodSync(file, mode);
  return true;
}

/**
 * The scrub run on every configuration layout (the current volumes and the legacy one): the
 * bootstrap key goes once this layout's state shows the manager has adopted it, the setup keys
 * once handed over.
 */
export function scrubKeys(
  layout: { manager: string; state: string },
  say: (line: string) => void,
): void {
  const store = new SetupStateStore(layout.state);
  const state = store.load();
  if (state.completedSteps.includes(ADOPTED_AFTER) && removeBootstrapKey(layout.manager)) {
    say("bootstrap admin key removed from the manager's settings");
  }
  if (dropSetupKeys(store)) say("admin, backend and builder keys dropped from setup's state");
}
