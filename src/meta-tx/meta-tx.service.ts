import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { Actor } from "../common/actor";
import { OperationRepository } from "../db/repositories/operation.repo";
import { validationFailed } from "../errors";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { PlatformService } from "../platform/platform.service";
import { FundsPolicyService } from "../policy/funds-policy.service";
import { WalletsService } from "../wallets/wallets.service";
import { MetaTxResponseDto } from "./dto/meta-tx-response.dto";

export type MetaTxKind = "allowance" | "redeem" | "split" | "merge" | "withdraw";

export type MetaTxArgs = {
  conditionId?: string;
  amountDecimal?: string;
  /** Either form; exactly one is resolved before the policy sees it. */
  recipient?: string;
  recipientWalletId?: string;
};

@Injectable()
export class MetaTxService {
  constructor(
    private readonly wallets: WalletsService,
    private readonly platform: PlatformService,
    private readonly policy: FundsPolicyService,
    private readonly upstream: DpmWalletClient,
    private readonly operations: OperationRepository,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Builds and signs a proxy meta-transaction, and returns it for the caller to submit.
   *
   * The order of operations is the point: resolve the recipient, ask the policy, and only then
   * call the upstream. A refused transfer must never produce a signature — a signed withdrawal
   * envelope is a bearer instrument, and "we signed it but did not return it" is not a
   * meaningful distinction once it exists.
   */
  async build(
    kind: MetaTxKind,
    walletId: string,
    args: MetaTxArgs,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<MetaTxResponseDto> {
    const wallet = await this.wallets.getReady(walletId);
    const recipient = await this.resolveRecipient(kind, args);

    const decision = await this.policy.assert({ action: kind, wallet, actor, recipient });

    const signed = await this.upstream.metaTx(
      kind,
      {
        ref: wallet.ref,
        ...(args.conditionId === undefined ? {} : { conditionId: args.conditionId }),
        ...(args.amountDecimal === undefined ? {} : { amountDecimal: args.amountDecimal }),
        ...(recipient === undefined ? {} : { recipient }),
      },
      idempotencyKey ? { idempotencyKey: `${idempotencyKey}:${kind}` } : {},
    );

    const operationId = randomUUID();
    await this.operations.insert({
      id: operationId,
      walletId: wallet.id,
      // A meta-transaction is always signed by the wallet it moves funds from; there is no
      // routing here, which is exactly why the funds policy has to carry the whole weight.
      signerWalletId: wallet.id,
      kind,
      mode: this.platform.mode,
      requestHash: hashRequest({ kind, ...args, recipient }),
      resultSummary: `${signed.from}:${signed.nonce}`,
      status: "signed",
      apiKeyId: actor.keyId,
      uiUserId: actor.userId,
      createdAt: new Date().toISOString(),
    });

    await this.audit.record({
      actor,
      walletId: wallet.id,
      action: AUDIT_ACTIONS[kind],
      outcome: AuditOutcome.Success,
      detail: {
        ...(args.conditionId === undefined ? {} : { conditionId: args.conditionId }),
        ...(args.amountDecimal === undefined ? {} : { amountDecimal: args.amountDecimal }),
        ...(recipient === undefined ? {} : { recipient }),
        external: decision.external,
        nonce: signed.nonce,
      },
    });

    return { ...signed, walletId: wallet.id, operationId, external: decision.external };
  }

  /**
   * Turns either recipient form into an address.
   *
   * A named wallet resolves to its **proxy** address, not its EOA: the proxy is where funds live,
   * and paying an EOA would strand them outside the wallet the caller meant.
   */
  private async resolveRecipient(kind: MetaTxKind, args: MetaTxArgs): Promise<string | undefined> {
    if (args.recipient && args.recipientWalletId) {
      throw validationFailed("Supply either recipient or recipientWalletId, not both");
    }
    if (args.recipientWalletId) {
      const target = await this.wallets.get(args.recipientWalletId);
      if (!target.proxyAddress) {
        throw validationFailed(
          `Wallet "${args.recipientWalletId}" has no address yet and cannot receive funds`,
        );
      }
      return target.proxyAddress;
    }
    if (args.recipient) return args.recipient;
    if (kind === "withdraw") {
      // Unlike redeem, a withdrawal with no destination is meaningless rather than a no-op.
      throw validationFailed("A withdrawal needs either recipient or recipientWalletId");
    }
    return undefined;
  }
}

const AUDIT_ACTIONS: Record<MetaTxKind, AuditAction> = {
  allowance: AuditAction.MetaAllowance,
  redeem: AuditAction.MetaRedeem,
  split: AuditAction.MetaSplit,
  merge: AuditAction.MetaMerge,
  withdraw: AuditAction.MetaWithdraw,
};

function hashRequest(request: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(request) ?? "null", "utf8")
    .digest("hex");
}
