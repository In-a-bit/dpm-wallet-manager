import crypto from "node:crypto";

import { mintApiKey } from "../crypto/api-key-format";

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
   * first boot, whose minted key only reaches a log line — which redacts it.
   */
  adminKey: string;
};

export function generateInstallSecrets(keyEnv: string): InstallSecrets {
  return {
    walletApiKey: `dpmw_${randomHex(20)}`,
    walletEncryptionKey: randomHex(32),
    managerMasterKey: randomHex(32),
    adminKey: mintApiKey(keyEnv, "admin").key,
  };
}

function randomHex(bytes: number): string {
  return crypto.randomBytes(bytes).toString("hex");
}
