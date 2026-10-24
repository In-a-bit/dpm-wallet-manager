import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MANAGER_ENV_FILE } from "./config-writer";
import { dropSetupKeys, isHandedOver, removeBootstrapKey, scrubKeys } from "./key-lifecycle";
import { runAll, scrubLegacy } from "./migrate";
import { generateInstallSecrets, withDbPasswords } from "./secrets";
import { STEPS } from "./steps";
import { SetupStateStore } from "./state";

const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "dpm-keys-"));
const ENV_WITH_KEY =
  "PORT='3000'\nDPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY='dpmm_dev_ad_x'\nOTHER='kept'\n";

/** A finished install: every step done, owner created, kit acknowledged. */
function finishedState(dir: string, over: { acknowledged?: boolean; owner?: boolean } = {}) {
  const store = new SetupStateStore(dir);
  store.update((state) => {
    state.answers = {
      environment: "dev",
      dpmApiUrl: "https://x",
      builderKey: "bld_sk_a",
      mode: "shared",
    };
    state.secrets = withDbPasswords(generateInstallSecrets("dev"));
    state.operatorKey = "dpmm_dev_op_y";
    state.completedSteps = STEPS.map((step) => step.id);
    state.backupAcknowledged = over.acknowledged ?? true;
    state.ownerCreated = over.owner ?? true;
  });
  return store;
}

describe("removeBootstrapKey", () => {
  it("removes only that line, keeps the file mode, and says whether it did", () => {
    const dir = tempDir();
    const file = path.join(dir, MANAGER_ENV_FILE);
    fs.writeFileSync(file, ENV_WITH_KEY, { mode: 0o600 });
    expect(removeBootstrapKey(dir)).toBe(true);
    expect(fs.readFileSync(file, "utf8")).toBe("PORT='3000'\nOTHER='kept'\n");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(removeBootstrapKey(dir)).toBe(false);
    expect(removeBootstrapKey(tempDir())).toBe(false);
  });
});

describe("dropSetupKeys", () => {
  it("keeps every key until setup is finished, the kit acknowledged and the owner created", () => {
    for (const over of [{ acknowledged: false }, { owner: false }]) {
      const store = finishedState(tempDir(), over);
      expect(isHandedOver(store.load())).toBe(false);
      expect(dropSetupKeys(store)).toBe(false);
      expect(store.load().secrets?.adminKey).toBeDefined();
    }
    const unfinished = finishedState(tempDir());
    unfinished.update((state) => {
      state.completedSteps = [];
    });
    expect(dropSetupKeys(unfinished)).toBe(false);
  });

  it("drops the admin, backend and builder keys, and nothing the rest of the install relies on", () => {
    const store = finishedState(tempDir());
    const before = store.load().secrets!;
    expect(dropSetupKeys(store)).toBe(true);
    const after = store.load();
    expect(after.secrets?.adminKey).toBeUndefined();
    expect(after.operatorKey).toBeUndefined();
    expect(after.answers?.builderKey).toBeUndefined();
    // The database role passwords and the backup recipient stay (they are remembered, not rotated).
    expect(after.secrets?.walletDbPassword).toBe(before.walletDbPassword);
    expect(after.secrets?.managerDbPassword).toBe(before.managerDbPassword);
    expect(after.secrets?.backupRecipient).toBe(before.backupRecipient);
    expect(after.secrets?.walletEncryptionKey).toBe(before.walletEncryptionKey);
    expect(after.completedSteps).toEqual(STEPS.map((step) => step.id));
    expect(dropSetupKeys(store)).toBe(false);
  });
});

describe("scrubKeys", () => {
  it("takes the bootstrap key out only once the manager has adopted it", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, MANAGER_ENV_FILE), ENV_WITH_KEY);
    const store = new SetupStateStore(dir);
    scrubKeys({ manager: dir, state: dir }, () => undefined);
    expect(fs.readFileSync(path.join(dir, MANAGER_ENV_FILE), "utf8")).toContain(
      "BOOTSTRAP_ADMIN_KEY",
    );
    store.update((state) => {
      state.completedSteps = [
        "write-config",
        "wallet-ready",
        "vault-init",
        "manager-ready",
        "master-wallet",
      ];
    });
    scrubKeys({ manager: dir, state: dir }, () => undefined);
    expect(fs.readFileSync(path.join(dir, MANAGER_ENV_FILE), "utf8")).not.toContain(
      "BOOTSTRAP_ADMIN_KEY",
    );
  });
});

describe("the scrubs through setup migrate", () => {
  const layout = () => ({
    legacy: tempDir(),
    wallet: tempDir(),
    manager: tempDir(),
    state: tempDir(),
  });
  /** An install from before this change: keys everywhere, in the legacy volume too. */
  function seedLegacy(dirs: ReturnType<typeof layout>) {
    fs.writeFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), ENV_WITH_KEY);
    fs.writeFileSync(path.join(dirs.legacy, "ready"), "");
    const store = finishedState(dirs.legacy);
    return store;
  }

  it("scrubs the new volumes at once and the legacy one only when it is writable", async () => {
    const dirs = layout();
    seedLegacy(dirs);
    await runAll({ ...dirs, legacyWritable: false }, () => undefined);
    // New volumes: bootstrap line gone, keys gone.
    expect(fs.readFileSync(path.join(dirs.manager, MANAGER_ENV_FILE), "utf8")).not.toContain(
      "BOOTSTRAP",
    );
    expect(new SetupStateStore(dirs.state).load().secrets?.adminKey).toBeUndefined();
    // Legacy, read-only here: untouched, so a rollback still has what it expects.
    expect(fs.readFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), "utf8")).toContain(
      "BOOTSTRAP",
    );
    expect(new SetupStateStore(dirs.legacy).load().secrets?.adminKey).toBeDefined();
  });

  it("scrubs the legacy volume in the writable run, as an upgrade by the new dpm-custody does", async () => {
    const dirs = layout();
    seedLegacy(dirs);
    await runAll({ ...dirs, legacyWritable: true }, () => undefined);
    expect(fs.readFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), "utf8")).not.toContain(
      "BOOTSTRAP",
    );
    expect(new SetupStateStore(dirs.legacy).load().secrets?.adminKey).toBeUndefined();
    expect(new SetupStateStore(dirs.legacy).load().operatorKey).toBeUndefined();
  });

  it("scrub-legacy (the later writable run after an upgrade by an older dpm-custody) cleans legacy and does not make the next migrate copy it over the new volumes", async () => {
    const dirs = layout();
    seedLegacy(dirs);
    // The older dpm-custody's upgrade: setup starts with legacy read-only.
    await runAll({ ...dirs, legacyWritable: false }, () => undefined);
    const stateFile = path.join(dirs.state, "setup-state.json");
    // The install moves on: a newer state in the new volume.
    new SetupStateStore(dirs.state).update((state) => {
      state.lastError = "newer than the legacy copy";
    });

    const lines: string[] = [];
    scrubLegacy({ ...dirs, legacyWritable: true }, (line) => lines.push(line));
    expect(fs.readFileSync(path.join(dirs.legacy, MANAGER_ENV_FILE), "utf8")).not.toContain(
      "BOOTSTRAP",
    );
    expect(new SetupStateStore(dirs.legacy).load().secrets?.adminKey).toBeUndefined();

    // Setup restarts: the scrubbed legacy volume is not mistaken for a rollback's changes.
    const again: string[] = [];
    await runAll({ ...dirs, legacyWritable: false }, (line) => again.push(line));
    expect(again.join("\\n")).toContain("already migrated");
    expect(JSON.parse(fs.readFileSync(stateFile, "utf8")).lastError).toBe(
      "newer than the legacy copy",
    );
  });

  it("scrub-legacy refuses a read-only legacy volume", () => {
    const dirs = layout();
    seedLegacy(dirs);
    expect(() => scrubLegacy({ ...dirs, legacyWritable: false }, () => undefined)).toThrow(
      /read-only/,
    );
  });
});
