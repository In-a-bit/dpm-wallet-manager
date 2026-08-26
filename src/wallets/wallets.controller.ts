import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from "@nestjs/common";
import {
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { CurrentActor, type Actor } from "../common/actor";
import { ApiAuth } from "../common/decorators/api-auth.decorator";
import { ApiErrors } from "../common/decorators/api-errors.decorator";
import { Roles } from "../common/decorators/roles.decorator";
import { IsUuidPipe } from "../common/pipes/uuid.pipe";
import {
  CreateWalletDto,
  DpmRegisteredDto,
  ListWalletsDto,
  UpdateWalletDto,
} from "./dto/wallet.dto";
import { DpmAttestationDto, WalletPageDto } from "./dto/wallet-page.dto";
import { toWalletResponse, WalletResponseDto } from "./dto/wallet-response.dto";
import { WalletsService } from "./wallets.service";

const WALLET_ID = {
  name: "id",
  format: "uuid",
  description: "The wallet's id, as returned by POST /v1/wallets.",
} as const;

@ApiTags("wallets")
@ApiAuth()
@Controller("wallets")
export class WalletsController {
  constructor(private readonly wallets: WalletsService) {}

  /**
   * Create a wallet.
   *
   * Writes the row first and mints the address second, so a crash in between leaves a
   * `provisioning` row rather than an address holding funds this service has no record of. Supply
   * an `externalId` to make retries safe: a duplicate is refused by a unique index rather than
   * producing a second wallet for one customer.
   *
   * The two platform wallets are not creatable here — they have their own endpoints under
   * `/v1/platform`, so "create a wallet" can never accidentally become "create the treasury".
   */
  @Post()
  @Roles("operator")
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ operationId: "createWallet", summary: "Create a wallet" })
  @ApiCreatedResponse({ type: WalletResponseDto })
  @ApiErrors("VALIDATION_FAILED", "EXTERNAL_ID_TAKEN", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED")
  async create(
    @Body() body: CreateWalletDto,
    @CurrentActor() actor: Actor,
  ): Promise<WalletResponseDto> {
    return toWalletResponse(
      await this.wallets.create({ externalId: body.externalId, label: body.label }, actor),
    );
  }

  /**
   * List wallets, filtered and paged.
   *
   * `q` matches a substring of the ref, external id, label or either address, case-insensitively.
   * `total` counts everything matching the filter, ignoring the page window.
   */
  @Get()
  @ApiOperation({ operationId: "listWallets", summary: "List wallets" })
  @ApiOkResponse({ type: WalletPageDto })
  @ApiErrors("VALIDATION_FAILED")
  async list(@Query() query: ListWalletsDto): Promise<WalletPageDto> {
    const page = await this.wallets.list(
      { kind: query.kind, status: query.status, q: query.q },
      query.limit,
      query.offset,
    );
    return {
      items: page.wallets.map(toWalletResponse),
      total: page.total,
      limit: query.limit,
      offset: query.offset,
    };
  }

  /**
   * Fetch a wallet by the caller's own identifier.
   *
   * Matched case-insensitively. Declared before `:id` so the literal segment is not parsed as an
   * identifier.
   */
  @Get("by-external/:externalId")
  @ApiOperation({ operationId: "getWalletByExternalId", summary: "Get a wallet by external id" })
  @ApiParam({ name: "externalId", description: "The identifier supplied at creation." })
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiErrors("WALLET_NOT_FOUND")
  async getByExternalId(@Param("externalId") externalId: string): Promise<WalletResponseDto> {
    return toWalletResponse(await this.wallets.getByExternalId(externalId));
  }

  /**
   * Fetch a wallet by its id.
   *
   * A wallet in `provisioning` is returned like any other, with null addresses — every signing
   * route refuses it until `POST /v1/wallets/{id}/reconcile` completes.
   */
  @Get(":id")
  @ApiOperation({ operationId: "getWallet", summary: "Get a wallet" })
  @ApiParam(WALLET_ID)
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiErrors("VALIDATION_FAILED", "WALLET_NOT_FOUND")
  async get(@Param("id", IsUuidPipe) id: string): Promise<WalletResponseDto> {
    return toWalletResponse(await this.wallets.get(id));
  }

  /**
   * Rename or disable a wallet.
   *
   * Wallets are never deleted: funds may still sit at the address, and forgetting it would turn a
   * platform address into an external one, which the funds policy would then refuse transfers to.
   * A disabled wallet cannot sign but still counts as ours.
   */
  @Patch(":id")
  @Roles("admin")
  @ApiOperation({ operationId: "updateWallet", summary: "Rename or disable a wallet" })
  @ApiParam(WALLET_ID)
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiErrors("VALIDATION_FAILED", "WALLET_NOT_FOUND", "WALLET_NOT_READY")
  async update(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: UpdateWalletDto,
    @CurrentActor() actor: Actor,
  ): Promise<WalletResponseDto> {
    const changes: { label?: string; status?: "active" | "disabled" } = {};
    if (body.label !== undefined) changes.label = body.label;
    if (body.status !== undefined) changes.status = body.status;
    return toWalletResponse(await this.wallets.update(id, changes, actor));
  }

  /**
   * Finish a provisioning that did not complete.
   *
   * Safe on an already-active wallet, and safe to repeat: the upstream `ref` is derived from the
   * wallet id, so a second attempt adopts the address the first one minted rather than creating
   * another. A boot sweep runs this over every stuck row automatically.
   */
  @Post(":id/reconcile")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "reconcileWallet", summary: "Finish a half-done provisioning" })
  @ApiParam(WALLET_ID)
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiErrors("VALIDATION_FAILED", "WALLET_NOT_FOUND", "UPSTREAM_UNAVAILABLE", "UPSTREAM_REJECTED")
  async reconcile(
    @Param("id", IsUuidPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<WalletResponseDto> {
    return toWalletResponse(await this.wallets.reconcile(id, actor));
  }

  /**
   * Sign the DPM platform's registration attestation.
   *
   * The private key never leaves dpm-wallet, so proof of control is the only thing that can be
   * handed over. Post the result to the DPM platform, then confirm with
   * `POST /v1/wallets/{id}/dpm-registered` — until that flag is set, no meta-transaction can be
   * signed for this wallet.
   */
  @Post(":id/dpm-attestation")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    operationId: "signDpmAttestation",
    summary: "Sign the DPM registration attestation",
  })
  @ApiParam(WALLET_ID)
  @ApiOkResponse({ type: DpmAttestationDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
    "WALLET_NOT_READY",
    "WALLET_DISABLED",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
  )
  signDpmAttestation(
    @Param("id", IsUuidPipe) id: string,
    @CurrentActor() actor: Actor,
  ): Promise<DpmAttestationDto> {
    return this.wallets.signDpmAttestation(id, actor);
  }

  /**
   * Record that the DPM platform has registered this wallet's EOA.
   *
   * A precondition for every meta-transaction: the RelayHub nonce is resolved from the platform's
   * user table, so an unregistered EOA cannot yield one. The stored flag mirrors what dpm-wallet
   * reports back, not what the request asked for.
   */
  @Post(":id/dpm-registered")
  @Roles("operator")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ operationId: "setDpmRegistered", summary: "Record DPM registration" })
  @ApiParam(WALLET_ID)
  @ApiOkResponse({ type: WalletResponseDto })
  @ApiErrors(
    "VALIDATION_FAILED",
    "WALLET_NOT_FOUND",
    "WALLET_NOT_READY",
    "WALLET_DISABLED",
    "UPSTREAM_UNAVAILABLE",
    "UPSTREAM_REJECTED",
  )
  async setDpmRegistered(
    @Param("id", IsUuidPipe) id: string,
    @Body() body: DpmRegisteredDto,
    @CurrentActor() actor: Actor,
  ): Promise<WalletResponseDto> {
    return toWalletResponse(await this.wallets.setDpmRegistered(id, body.registered, actor));
  }
}
