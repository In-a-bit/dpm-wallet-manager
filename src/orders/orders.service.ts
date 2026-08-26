import { createHash, randomUUID } from "node:crypto";

import { Injectable } from "@nestjs/common";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { Actor } from "../common/actor";
import { OperationRepository } from "../db/repositories/operation.repo";
import type { ReadyWallet } from "../db/repositories/wallet.repo";
import { AuditLog } from "../observability/audit";
import { AuditAction, AuditOutcome } from "../observability/audit-action";
import { PlatformService } from "../platform/platform.service";
import { FundsPolicyService } from "../policy/funds-policy.service";
import { WalletsService } from "../wallets/wallets.service";
import { SignedCancelResponseDto, SignedOrderResponseDto } from "./dto/order-response.dto";
import { routeOrder, type OrderSide } from "./order-routing";

export type SignOrderRequest = {
  side: OrderSide;
  tokenId: string;
  shares: number;
  price: number;
  feeRateBps: number;
};

@Injectable()
export class OrdersService {
  constructor(
    private readonly wallets: WalletsService,
    private readonly platform: PlatformService,
    private readonly policy: FundsPolicyService,
    private readonly upstream: DpmWalletClient,
    private readonly operations: OperationRepository,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Signs an order on behalf of `walletId`, whoever ends up funding it.
   *
   * The response carries a `routing` block rather than just the signed order. A caller in shared
   * mode asked for "wallet X buys" and got back an order whose maker is a different address; that
   * has to be visible, or the first person to read the signed order will file a bug.
   */
  async signOrder(
    walletId: string,
    request: SignOrderRequest,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<SignedOrderResponseDto> {
    const wallet = await this.wallets.getReady(walletId);
    await this.policy.assert({ action: "order", wallet, actor });

    const routing = routeOrder({
      mode: this.platform.mode,
      side: request.side,
      wallet,
      operationsWallet: await this.operationsWallet(),
    });
    // In shared mode the signer is a different wallet, and it has to be usable in its own right —
    // a disabled or half-provisioned treasury must fail here, not at the exchange.
    await this.policy.assert({ action: "order", wallet: routing.signer, actor });

    const signed = await this.upstream.signOrder(
      {
        ref: routing.signer.ref,
        maker: routing.maker,
        side: request.side,
        tokenId: request.tokenId,
        shares: request.shares,
        price: request.price,
        feeRateBps: request.feeRateBps,
        // Omitted rather than sent as the zero address, so the request says what it means.
        ...(routing.recipient === undefined ? {} : { recipient: routing.recipient }),
      },
      idempotencyKey ? { idempotencyKey: `${idempotencyKey}:order` } : {},
    );

    const operationId = await this.record({
      kind: "order",
      wallet,
      routing,
      actor,
      request,
      resultSummary: signed.orderHash,
    });

    await this.audit.record({
      actor,
      walletId: wallet.id,
      action: AuditAction.SignOrder,
      outcome: AuditOutcome.Success,
      detail: {
        side: request.side,
        tokenId: request.tokenId,
        shares: request.shares,
        price: request.price,
        signerWalletId: routing.signer.id,
        maker: routing.maker,
        recipient: routing.recipient ?? null,
        orderHash: signed.orderHash,
      },
    });

    return {
      ...signed,
      routing: {
        mode: routing.mode,
        side: routing.side,
        walletId: wallet.id,
        signerWalletId: routing.signer.id,
        maker: routing.maker,
        recipient: routing.recipient ?? null,
      },
      operationId,
    };
  }

  /**
   * Cancels an order, signed by whichever wallet signed the order in the first place.
   *
   * That is not always the wallet the caller names: in shared mode a BUY was signed by the
   * operations wallet, and a cancel signed by the user would carry the wrong signer. So the
   * ledger is consulted first, and the routing rules are only a fallback for an order this
   * install did not sign.
   */
  async signCancel(
    walletId: string,
    orderHash: string,
    marketId: string,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<SignedCancelResponseDto> {
    const wallet = await this.wallets.getReady(walletId);
    await this.policy.assert({ action: "cancel", wallet, actor });

    const signer = await this.cancelSigner(wallet, orderHash);
    const signed = await this.upstream.signCancel(
      { ref: signer.ref, orderHash, marketId },
      idempotencyKey ? { idempotencyKey: `${idempotencyKey}:cancel` } : {},
    );

    const operationId = await this.record({
      kind: "cancel",
      wallet,
      routing: { signer },
      actor,
      request: { orderHash, marketId },
      resultSummary: orderHash,
    });

    await this.audit.record({
      actor,
      walletId: wallet.id,
      action: AuditAction.SignCancel,
      outcome: AuditOutcome.Success,
      detail: { orderHash, marketId, signerWalletId: signer.id },
    });

    return { ...signed, walletId: wallet.id, signerWalletId: signer.id, operationId };
  }

  /**
   * The wallet that signed this order, from our own ledger. Falling back to the named wallet is
   * right for an order signed elsewhere — the exchange will reject a cancel from the wrong signer,
   * which is a clearer failure than refusing to try.
   */
  private async cancelSigner(wallet: ReadyWallet, orderHash: string): Promise<ReadyWallet> {
    const original = await this.operations.findOrderByHash(orderHash);
    if (!original || original.signerWalletId === wallet.id) return wallet;
    const signer = await this.wallets.getReady(original.signerWalletId);
    return signer;
  }

  private async operationsWallet(): Promise<ReadyWallet | undefined> {
    if (!this.platform.isShared) return undefined;
    const operations = await this.platform.requireOperationsWallet();
    // `getReady` is what refuses a treasury that never finished provisioning or has been
    // disabled — without it, a null address would be named as the maker of every BUY.
    return this.wallets.getReady(operations.id);
  }

  private async record(entry: {
    kind: "order" | "cancel";
    wallet: ReadyWallet;
    routing: { signer: ReadyWallet };
    actor: Actor;
    request: unknown;
    resultSummary: string;
  }): Promise<string> {
    const id = randomUUID();
    await this.operations.insert({
      id,
      walletId: entry.wallet.id,
      signerWalletId: entry.routing.signer.id,
      kind: entry.kind,
      mode: this.platform.mode,
      requestHash: hashRequest(entry.request),
      resultSummary: entry.resultSummary,
      status: "signed",
      apiKeyId: entry.actor.keyId,
      createdAt: new Date().toISOString(),
    });
    return id;
  }
}

/** Correlates retries of one intended action; never a secret, so a plain digest is enough. */
function hashRequest(request: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(request) ?? "null", "utf8")
    .digest("hex");
}
