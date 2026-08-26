import { Body, Controller, Get, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { PlatformWalletResponseDto, toWalletResponse } from "../wallets/dto/wallet-response.dto";
import { CreatePlatformWalletDto } from "./dto/platform.dto";
import { PlatformStatusDto } from "./dto/platform-status.dto";
import { PlatformService } from "./platform.service";

@ApiTags("platform")
@ApiAuth()
@Controller("platform")
export class PlatformController {
  constructor(private readonly platform: PlatformService) {}

  /**
   * The install's state, in one call.
   *
   * The custody mode and when it was fixed, both platform wallets, how many wallets exist, and
   * whether dpm-wallet is answering — everything a backoffice landing page needs.
   *
   * Readable by either role: an operator who cannot see which mode they are trading in cannot
   * reason about what their own orders will do.
   */
  @Get()
  @ApiOperation({ operationId: "getPlatformStatus", summary: "Get the install's state" })
  @ApiOkResponse({ type: PlatformStatusDto })
  async status(): Promise<PlatformStatusDto> {
    const status = await this.platform.status();
    return {
      ...status,
      // Explicit nulls rather than absent keys, and the same wallet shape `/v1/wallets` returns:
      // a UI reading this should not have to handle two representations of a wallet.
      masterWallet: status.masterWallet ? toWalletResponse(status.masterWallet) : null,
      operationsWallet: status.operationsWallet ? toWalletResponse(status.operationsWallet) : null,
    };
  }

  /**
   * Create the master wallet.
   *
   * Admin only: this wallet is the one place USDC may leave the platform from, so creating it is
   * the same decision as deciding where the exit door goes. It is deliberately never given an
   * allowance, and cannot trade.
   *
   * Idempotent — returns the existing wallet rather than refusing a second call.
   */
  @Post("master-wallet")
  @Roles("admin")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "createMasterWallet", summary: "Create the master wallet" })
  @ApiOkResponse({ type: PlatformWalletResponseDto })
  @ApiErrors("VALIDATION_FAILED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED")
  async createMasterWallet(
    @Body() body: CreatePlatformWalletDto,
    @CurrentActor() actor: Actor,
  ): Promise<PlatformWalletResponseDto> {
    return toWalletResponse(await this.platform.createMasterWallet(actor, body.label));
  }

  /**
   * Create the operations wallet.
   *
   * Operator-reachable: standing up the treasury is operations work rather than administration.
   * In shared mode it holds all the collateral — it makes every BUY and receives every SELL. In
   * segregated mode it is allowed but unused, and the response says so rather than refusing, so
   * one provisioning script works for both deployments.
   *
   * Idempotent — returns the existing wallet rather than refusing a second call.
   */
  @Post("operations-wallet")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "createOperationsWallet", summary: "Create the operations wallet" })
  @ApiOkResponse({ type: PlatformWalletResponseDto })
  @ApiErrors("VALIDATION_FAILED", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED")
  async createOperationsWallet(
    @Body() body: CreatePlatformWalletDto,
    @CurrentActor() actor: Actor,
  ): Promise<PlatformWalletResponseDto> {
    const wallet = await this.platform.createOperationsWallet(actor, body.label);
    return {
      ...toWalletResponse(wallet),
      ...(this.platform.isShared
        ? {}
        : { note: "This install runs in segregated mode; the operations wallet is unused." }),
    };
  }
}
