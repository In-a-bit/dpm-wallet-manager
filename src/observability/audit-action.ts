/**
 * Every action name the audit trail can carry.
 *
 * Operators and the backoffice UI filter `GET /v1/audit` by this exact string, so a typo at a
 * call site would silently drop an event out of the filter an incident is being investigated
 * with. Naming them here makes that a compile error.
 */
export const AuditAction = {
  KeyCreate: "key.create",
  KeyRotate: "key.rotate",
  KeyReveal: "key.reveal",
  KeyRevoke: "key.revoke",
  KeyBootstrap: "key.bootstrap",
  AuthFailed: "auth.failed",

  PlatformModeBurned: "platform.mode_burned",
  PlatformMasterWalletCreate: "platform.master_wallet_create",
  PlatformOperationsWalletCreate: "platform.operations_wallet_create",

  WalletCreate: "wallet.create",
  WalletReconcile: "wallet.reconcile",
  WalletUpdate: "wallet.update",
  WalletDpmAttestation: "wallet.dpm_attestation",
  WalletDpmRegistered: "wallet.dpm_registered",

  SignOrder: "sign.order",
  SignCancel: "sign.cancel",

  MetaAllowance: "meta.allowance",
  MetaRedeem: "meta.redeem",
  MetaSplit: "meta.split",
  MetaMerge: "meta.merge",
  MetaWithdraw: "meta.withdraw",
  /**
   * Its own name, distinct from `meta.withdraw`, because this is the one event that means money
   * left the platform. An alert or a UI filter should be able to select exactly it.
   */
  MetaWithdrawExternal: "meta.withdraw.external",
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** `denied` is as important as `success`: a refused withdrawal is where an incident starts. */
export const AuditOutcome = {
  Success: "success",
  Denied: "denied",
  Failure: "failure",
} as const;

export type AuditOutcome = (typeof AuditOutcome)[keyof typeof AuditOutcome];
