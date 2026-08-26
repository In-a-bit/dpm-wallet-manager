import { Body, Controller, Headers, HttpCode, HttpStatus, Param, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiParam, ApiTags } from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { ApiIdempotencyKey } from "../common/decorators/api-idempotency.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { IsUuidPipe } from "../common/pipes/uuid.pipe";
import { SignCancelDto, SignOrderDto } from "./dto/order.dto";
import { SignedCancelResponseDto, SignedOrderResponseDto } from "./dto/order-response.dto";
import { OrdersService } from "./orders.service";

const WALLET_ID = {
  name: "id",
  format: "uuid",
  description:
    "The user-facing wallet the trade is for. Which wallet actually signs is decided from the " +
    "custody mode and reported in `routing`.",
} as const;

/**
 * Signed orders, returned rather than submitted: this service never talks to the CLOB. The caller
 * posts what it gets back.
 */
@ApiTags("orders")
@ApiAuth()
@Controller("wallets/:id/orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {}

  /**
   * Build and sign an order.
   *
   * The caller says what to trade and for how much; it does **not** say who signs, who funds or
   * who is paid. Those follow from the custody mode:
   *
   * | mode | side | signs | maker (funds) | recipient (proceeds) |
   * | --- | --- | --- | --- | --- |
   * | segregated | BUY | this wallet | its proxy | — |
   * | segregated | SELL | this wallet | its proxy | — |
   * | shared | BUY | **operations** | operations proxy | this wallet's proxy |
   * | shared | SELL | this wallet | its proxy | operations proxy |
   *
   * The maker is always the source of funds; the recipient only receives proceeds. The `routing`
   * block in the response reports what was decided.
   */
  @Post("sign")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signOrder", summary: "Build and sign an order" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: SignedOrderResponseDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
    "WALLET_NOT_READY",
    "WALLET_DISABLED",
    "MASTER_WALLET_CANNOT_TRADE",
    "OPERATIONS_WALLET_REQUIRED",
    "IDEMPOTENCY_CONFLICT",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
  )
  signOrder(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: SignOrderDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<SignedOrderResponseDto> {
    return this.orders.signOrder(id, body, actor, idempotencyKey);
  }

  /**
   * Sign a cancel message for an existing order.
   *
   * Signed by whoever signed the order, which is not always the wallet named here: in shared mode
   * a BUY was signed by the operations wallet, and a cancel from the user would carry the wrong
   * signer. The signer is looked up in this install's own operations ledger, falling back to the
   * named wallet for an order signed elsewhere.
   */
  @Post("cancel")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "signCancel", summary: "Sign an order cancellation" })
  @ApiParam(WALLET_ID)
  @ApiIdempotencyKey()
  @ApiOkResponse({ type: SignedCancelResponseDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
    "WALLET_NOT_READY",
    "WALLET_DISABLED",
    "MASTER_WALLET_CANNOT_TRADE",
    "IDEMPOTENCY_CONFLICT",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
  )
  signCancel(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: SignCancelDto,
    @CurrentActor() actor: Actor,
    @Headers("idempotency-key") idempotencyKey?: string,
  ): Promise<SignedCancelResponseDto> {
    return this.orders.signCancel(id, body.orderHash, body.marketId, actor, idempotencyKey);
  }
}
