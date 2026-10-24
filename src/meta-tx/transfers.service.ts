import { Injectable } from "@nestjs/common";

import { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { UpstreamRelayTransaction } from "../clients/dpm-wallet.types";
import { forwardedKey, type Actor } from "../common/actor";
import { OperationRepository } from "../db/repositories/operation.repo";
import { internalError, ManagerError } from "../errors";
import { WalletsService } from "../wallets/wallets.service";
import type { TransferResponseDto, TransferStatusDto } from "./dto/transfer-response.dto";
import { MetaTxService, type MetaTxArgs } from "./meta-tx.service";

/**
 * Withdrawals this service relays itself, rather than handing the signed body back.
 *
 * Signing goes through `MetaTxService.build` unchanged, so the funds policy, the operation row
 * and the audit entry are exactly those of `/withdraw`. The only addition is the relay, and the
 * relayer's id kept on the operation so the transfer can be followed afterwards.
 */
@Injectable()
export class TransfersService {
  constructor(
    private readonly metaTx: MetaTxService,
    private readonly wallets: WalletsService,
    private readonly upstream: DpmWalletClient,
    private readonly operations: OperationRepository,
  ) {}

  /**
   * A relay that fails after signing leaves the operation as `/withdraw` would have: recorded and
   * signed, with no relayer id. The upstream error is surfaced as it came.
   */
  async transfer(
    walletId: string,
    args: MetaTxArgs,
    actor: Actor,
    idempotencyKey?: string,
  ): Promise<TransferResponseDto> {
    const built = await this.metaTx.build("withdraw", walletId, args, actor, idempotencyKey);
    // Ours, not the relayer's: everything else is its own request shape, sent as signed.
    const { walletId: _walletId, operationId, external, ...signed } = built;

    // Keyed apart from the signing call (`:withdraw`): dpm-wallet stores one response per key, so
    // the same key on /relay would be a different body under a key already taken. With it, a
    // retry after a crash replays both the signature and the relay instead of submitting twice.
    const relayed = await this.upstream.relay(
      signed,
      idempotencyKey ? { idempotencyKey: forwardedKey(actor, idempotencyKey, "relay") } : {},
    );
    const relayerTransactionId = transactionId(relayed);
    if (!relayerTransactionId) {
      throw new ManagerError("UPSTREAM_REJECTED", "The relayer accepted no transaction id", {
        details: { upstream: null, operationId },
      });
    }
    await this.operations.setRelayerTransactionId(operationId, relayerTransactionId);

    return { operationId, relayerTransactionId, state: relayed.state ?? null, external };
  }

  /** Asked of the relayer as the EOA that signed, which is how it keys transactions. */
  async status(relayerTransactionId: string): Promise<TransferStatusDto> {
    const operation = await this.operations.findByRelayerTransactionId(relayerTransactionId);
    if (!operation) {
      throw new ManagerError(
        "TRANSFER_NOT_FOUND",
        `No transfer with relayer id "${relayerTransactionId}"`,
        { details: { relayerTransactionId } },
      );
    }
    const signer = await this.wallets.get(operation.signerWalletId);
    // A wallet that signed has an EOA; a row without one here means the directory was edited.
    if (!signer.eoaAddress) throw internalError("The transfer's signer has no address");
    const transaction = await this.upstream.relayStatus(relayerTransactionId, signer.eoaAddress);
    return {
      relayerTransactionId,
      state: transaction.state ?? null,
      transactionHash: transaction.transactionHash ?? transaction.transaction_hash ?? null,
    };
  }
}

function transactionId(transaction: UpstreamRelayTransaction): string | undefined {
  return transaction.transactionID ?? transaction.transaction_id;
}
