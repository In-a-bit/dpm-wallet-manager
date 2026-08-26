import { Injectable } from "@nestjs/common";

import type { Actor } from "../common/actor";
import { WalletRepository, type Wallet } from "../db/repositories/wallet.repo";
import { ManagerError } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";

/** The actions this service arbitrates. Anything not listed here moves no value. */
export type PolicyAction =
  "order" | "cancel" | "allowance" | "split" | "merge" | "redeem" | "withdraw";

export type PolicyRequest = {
  action: PolicyAction;
  /** The wallet the value would move *from*. */
  wallet: Wallet;
  actor: Actor;
  /** Set for `withdraw`, and for a `redeem` that forwards its payout. */
  recipient?: string | undefined;
};

/** What the caller learns about a permitted action, so it can be recorded accurately. */
export type PolicyDecision = {
  /** True when the funds are leaving the platform entirely. Audited under its own action name. */
  external: boolean;
};

/**
 * The single gate on every value-moving signature.
 *
 * There is exactly one substantive rule, and it is the constraint the whole platform is built
 * around: **USDC may leave the platform only from the master wallet, and only with an admin
 * key.** Everything internal — user to user, user to treasury, treasury to master — is
 * unrestricted with an operator key, because those movements stay inside the platform's own
 * balance sheet and the business logic that governs them lives in the caller.
 *
 * Two supporting rules exist because the master wallet is deliberately kept out of trading:
 * it never receives an allowance, so it cannot trade, and letting it try would produce orders and
 * approvals that fail on-chain for reasons nobody would connect back to this decision.
 *
 * Every decision — permitted or refused — writes an audit row. A refused withdrawal is the event
 * an incident starts from, so it is at least as important as a successful one.
 */
@Injectable()
export class FundsPolicyService {
  constructor(
    private readonly wallets: WalletRepository,
    private readonly audit: AuditLog,
  ) {}

  async assert(request: PolicyRequest): Promise<PolicyDecision> {
    const { action, wallet, actor } = request;

    if (wallet.kind === "master") {
      if (action === "order" || action === "cancel") {
        throw await this.deny(
          request,
          "MASTER_WALLET_CANNOT_TRADE",
          "The master wallet does not trade; it holds funds for withdrawal only",
        );
      }
      if (action === "allowance") {
        throw await this.deny(
          request,
          "MASTER_ALLOWANCE_FORBIDDEN",
          "The master wallet is deliberately left without an allowance, so it cannot be spent " +
            "by the exchange or the proxy",
        );
      }
    }

    // No recipient, no exit: allowance, split, merge and a bare redeem all leave the funds where
    // they are.
    if (request.recipient === undefined) return { external: false };

    if (await this.wallets.isPlatformAddress(request.recipient)) {
      return { external: false };
    }

    if (wallet.kind !== "master") {
      throw await this.deny(
        request,
        "EXTERNAL_TRANSFER_FORBIDDEN",
        `Funds may only leave the platform from the master wallet; "${wallet.id}" is a ` +
          `${wallet.kind} wallet. Move them to the master wallet first.`,
      );
    }
    if (actor.role !== "admin") {
      throw await this.deny(
        request,
        "EXTERNAL_TRANSFER_FORBIDDEN",
        "Withdrawing from the master wallet to an address outside the platform requires an " +
          "admin key",
      );
    }

    // The one path by which money leaves. Recorded under its own action name so it can be alerted
    // on without matching every other withdrawal.
    await this.audit.record({
      actor,
      walletId: wallet.id,
      action: AuditAction.MetaWithdrawExternal,
      outcome: AuditOutcome.Success,
      detail: { action, recipient: request.recipient, walletKind: wallet.kind },
    });
    return { external: true };
  }

  /** Records the refusal before raising it, so a denial is never a silent 403. */
  private async deny(
    request: PolicyRequest,
    code:
      "EXTERNAL_TRANSFER_FORBIDDEN" | "MASTER_ALLOWANCE_FORBIDDEN" | "MASTER_WALLET_CANNOT_TRADE",
    message: string,
  ): Promise<ManagerError> {
    await this.audit.record({
      actor: request.actor,
      walletId: request.wallet.id,
      action: actionFor(request.action),
      outcome: AuditOutcome.Denied,
      detail: {
        reason: code,
        walletKind: request.wallet.kind,
        actorRole: request.actor.role,
        ...(request.recipient === undefined ? {} : { recipient: request.recipient }),
      },
    });
    return new ManagerError(code, message, {
      details: { walletId: request.wallet.id, walletKind: request.wallet.kind },
    });
  }
}

function actionFor(action: PolicyAction): AuditAction {
  switch (action) {
    case "order":
      return AuditAction.SignOrder;
    case "cancel":
      return AuditAction.SignCancel;
    case "allowance":
      return AuditAction.MetaAllowance;
    case "split":
      return AuditAction.MetaSplit;
    case "merge":
      return AuditAction.MetaMerge;
    case "redeem":
      return AuditAction.MetaRedeem;
    case "withdraw":
      return AuditAction.MetaWithdraw;
  }
}
