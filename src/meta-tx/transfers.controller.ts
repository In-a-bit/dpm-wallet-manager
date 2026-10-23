import { Body, Controller, Get, Headers, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { ApiIdempotencyKey } from "../common/decorators/api-idempotency.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { IsUuidPipe } from "../common/pipes/uuid.pipe";
import { MetaTxWithdrawDto } from "./dto/meta-tx.dto";
import { TransferResponseDto, TransferStatusDto } from "./dto/transfer-response.dto";
import { toArgs } from "./meta-tx.controller";
import { TransfersService } from "./transfers.service";

/**
 * Withdrawals signed **and relayed** here, for a caller that has no relayer access of its own.
 *
 * The signing half is `POST /v1/wallets/{id}/withdraw`, policy and all; this only adds the
 * submission to relayer-api through dpm-wallet, and a way to follow it afterwards.
 */
@ApiTags("transfers")
@ApiAuth()
@Controller()
export class TransfersController {
  constructor(private readonly transfers: TransfersService) {}

  /**
   * Sign and relay a USDC transfer out of a wallet.
   *
   * The same rule as a withdrawal, checked before anything is signed: to an address in this
   * directory from any wallet with an operator key; to any other address only from the master
   * wallet with an admin key, else `EXTERNAL_TRANSFER_FORBIDDEN`.
   *
   * If the relay fails after signing, the operation stays recorded as signed, with no relayer id,
   * and the relayer's refusal is returned.
   */
  @Post("wallets/:id/transfers")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "createTransfer", summary: "Sign and relay a USDC transfer" })
  @ApiParam({
    name: "id",
    format: "uuid",
    description: "The wallet the funds move from. It signs; there is no routing here.",
  })
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: TransferResponseDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
    "WALLET_NOT_READY",
    "WALLET_DISABLED",
    "WALLET_NOT_REGISTERED",
    "EXTERNAL_TRANSFER_FORBIDDEN",
    "IDEMPOTENCY_CONFLICT",
    "TRANSFER_REJECTED",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
  )
  create(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: MetaTxWithdrawDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<TransferResponseDto> {
    return this.transfers.transfer(id, toArgs(body), actor, idempotencyKey);
  }

  /**
   * The relayer's current state for a transfer relayed here, and its on-chain hash once it has
   * one. Only ids this service relayed are known; any other is `TRANSFER_NOT_FOUND`.
   */
  @Get("transfers/:relayerTransactionId")
  @ApiOperation({ operationId: "getTransfer", summary: "Get a relayed transfer's status" })
  @ApiParam({
    name: "relayerTransactionId",
    description: "As returned when the transfer was made.",
  })
  @ApiOkResponse({ type: TransferStatusDto })
  @ApiErrors("TRANSFER_NOT_FOUND", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED")
  status(@Param("relayerTransactionId") relayerTransactionId: string): Promise<TransferStatusDto> {
    return this.transfers.status(relayerTransactionId);
  }
}
