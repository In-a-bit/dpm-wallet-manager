import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { ApiIdempotencyKey } from "../common/decorators/api-idempotency.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { IsUuidPipe } from "../common/pipes/uuid.pipe";
import type { ErrorCode } from "../errors";
import { MetaTxRedeemDto, MetaTxSplitDto, MetaTxWithdrawDto } from "./dto/meta-tx.dto";
import { MetaTxResponseDto } from "./dto/meta-tx-response.dto";
import { MetaTxService, type MetaTxArgs } from "./meta-tx.service";

const WALLET_ID = {
  name: "id",
  format: "uuid",
  description: "The wallet the funds move from. It signs; there is no routing here.",
} as const;

/** Shared by all five: everything that can go wrong before the policy has an opinion. */
const COMMON_ERRORS: ErrorCode[] = [
  "VALIDATION_FAILED",
  "WALLET_NOT_FOUND",
  "WALLET_NOT_READY",
  "WALLET_DISABLED",
  "WALLET_NOT_REGISTERED",
  "IDEMPOTENCY_CONFLICT",
  "UPSTREAM_UNAVAILABLE",
  "UPSTREAM_REJECTED",
];

/**
 * Proxy meta-transactions, returned rather than submitted: each response is a complete body the
 * caller POSTs to relayer-api's `/submit`. This service never broadcasts anything.
 *
 * All five are operator-reachable. Only one of them can move funds off the platform, and that is
 * gated by the wallet and the role rather than by the route.
 *
 * Every one of them requires the wallet's EOA to be registered with the DPM platform first — see
 * `POST /v1/wallets/{id}/dpm-attestation`.
 */
@ApiTags("meta-tx")
@ApiAuth()
@Controller("wallets/:id")
export class MetaTxController {
  constructor(private readonly metaTx: MetaTxService) {}

  /**
   * Approve USDC and the CTF exchange.
   *
   * Three proxy calls in one batch: approve USDC for the conditional-tokens contract (for
   * splits), approve USDC for the exchange (for BUYs), and set approval-for-all on the CTF for the
   * exchange (for SELLs). Takes no body.
   *
   * Refused for the master wallet, which is deliberately left without an allowance so it cannot be
   * spent by the exchange or the proxy.
   */
  @Post("allowance")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signAllowance", summary: "Sign a USDC and CTF allowance" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: MetaTxResponseDto })
  @ApiErrors(...COMMON_ERRORS, "MASTER_ALLOWANCE_FORBIDDEN")
  allowance(
    @Param("id", IsUuidPipe) id: string,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<MetaTxResponseDto> {
    return this.metaTx.build("allowance", id, {}, actor, idempotencyKey);
  }

  /**
   * Redeem a resolved position.
   *
   * Omit the recipient to leave the collateral in the proxy wallet. Supplying one makes this a
   * transfer — the upstream quotes the payout from the relayer and forwards exactly that much in
   * the same proxy transaction — so it is subject to the same rule as a withdrawal.
   */
  @Post("redeem")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signRedeem", summary: "Sign a redemption" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: MetaTxResponseDto })
  @ApiErrors(...COMMON_ERRORS, "EXTERNAL_TRANSFER_FORBIDDEN")
  redeem(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: MetaTxRedeemDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<MetaTxResponseDto> {
    return this.metaTx.build("redeem", id, toArgs(body), actor, idempotencyKey);
  }

  /**
   * Split collateral into a complete set of outcome tokens.
   *
   * Spends USDC from the wallet's proxy and mints one token of every outcome. Moves nothing off
   * the platform, so it needs only an operator key.
   */
  @Post("split")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signSplit", summary: "Sign a position split" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: MetaTxResponseDto })
  @ApiErrors(...COMMON_ERRORS)
  split(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: MetaTxSplitDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<MetaTxResponseDto> {
    return this.metaTx.build("split", id, toArgs(body), actor, idempotencyKey);
  }

  /**
   * Merge a complete set of outcome tokens back into collateral.
   *
   * The inverse of a split: burns one token of every outcome and returns USDC to the wallet's
   * proxy. Moves nothing off the platform, so it needs only an operator key.
   */
  @Post("merge")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signMerge", summary: "Sign a position merge" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: MetaTxResponseDto })
  @ApiErrors(...COMMON_ERRORS)
  merge(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: MetaTxSplitDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<MetaTxResponseDto> {
    return this.metaTx.build("merge", id, toArgs(body), actor, idempotencyKey);
  }

  /**
   * Transfer USDC out of a wallet's proxy.
   *
   * The one endpoint that can take funds off the platform, and the only place the platform's
   * central constraint applies:
   *
   * - to an address in this directory — allowed from any wallet, with an operator key;
   * - to any other address — allowed **only** from the master wallet, and **only** with an admin
   *   key. Anything else is `EXTERNAL_TRANSFER_FORBIDDEN`.
   *
   * The refusal happens before anything is signed: a signed withdrawal envelope is a bearer
   * instrument, so "we signed it but did not return it" would not be a meaningful distinction.
   */
  @Post("withdraw")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signWithdraw", summary: "Sign a USDC transfer out of a wallet" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: MetaTxResponseDto })
  @ApiErrors(...COMMON_ERRORS, "EXTERNAL_TRANSFER_FORBIDDEN")
  withdraw(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: MetaTxWithdrawDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<MetaTxResponseDto> {
    return this.metaTx.build("withdraw", id, toArgs(body), actor, idempotencyKey);
  }
}

function toArgs(body: Partial<MetaTxRedeemDto & MetaTxSplitDto & MetaTxWithdrawDto>): MetaTxArgs {
  return {
    ...(body.conditionId === undefined ? {} : { conditionId: body.conditionId }),
    ...(body.amountDecimal === undefined ? {} : { amountDecimal: body.amountDecimal }),
    ...(body.recipient === undefined ? {} : { recipient: body.recipient }),
    ...(body.recipientWalletId === undefined ? {} : { recipientWalletId: body.recipientWalletId }),
  };
}
