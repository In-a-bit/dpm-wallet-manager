import crypto from "node:crypto";

import { mintApiKey } from "../crypto/api-key-format";
import { generateRecoveryKeyPair } from "./backup-crypto";

/** Every secret an install is born with. None of them is ever typed by a person. */
export type InstallSecrets = {
  /** dpm-wallet's own `DPM_WALLET_API_KEY`; only dpm-wallet-manager holds it. */
  walletApiKey: string;
  /** `DPM_WALLET_ENCRYPTION_KEY`: losing it loses the Turnkey sub-organization. */
  walletEncryptionKey: string;
  /** `DPM_WALLET_MANAGER_MASTER_KEY`: losing it makes every API key unverifiable. */
  managerMasterKey: string;
  /**
   * `DPM_WALLET_MANAGER_BOOTSTRAP_ADMIN_KEY`. Generated here rather than left to the manager's
   * first boot, whose minted key only reaches a log line — which redacts it. Removed from the
   * manager's env once adopted, and from setup's state once setup is finished (key-lifecycle.ts):
   * later it is revealed in the admin UI.
   */
  adminKey?: string;
  /** Passwords of the least-privilege database roles each service connects as (db-roles.ts). */
  walletDbPassword: string;
  managerDbPassword: string;
  /** Backups are sealed to this public key (backup-crypto.ts); it is not a secret. */
  backupRecipient?: string;
  /**
   * The matching private key. Held only until the owner has seen the kit once, then deleted: it
   * must not stay on the machine whose backups it opens.
   */
  backupRecoveryKey?: string;
};

/** Secrets saved by an earlier version have no database passwords; mint them when first needed. */
export function withDbPasswords(secrets: InstallSecrets): InstallSecrets {
  return {
    ...secrets,
    walletDbPassword: secrets.walletDbPassword ?? randomHex(24),
    managerDbPassword: secrets.managerDbPassword ?? randomHex(24),
  };
}

export function generateInstallSecrets(keyEnv: string): InstallSecrets {
  const recovery = generateRecoveryKeyPair();
  return {
    backupRecipient: recovery.recipient,
    backupRecoveryKey: recovery.recoveryKey,
    walletApiKey: `dpmw_${randomHex(20)}`,
    walletEncryptionKey: randomHex(32),
    managerMasterKey: randomHex(32),
    adminKey: mintApiKey(keyEnv, "admin").key,
    walletDbPassword: randomHex(24),
    managerDbPassword: randomHex(24),
  };
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}
