import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional } from "class-validator";

import { PaginationDto } from "../../common/dto/pagination.dto";
import { IsExternalId, IsLabel, Trimmed } from "../../common/validation/decorators";
import {
  WALLET_KINDS,
  WALLET_STATUSES,
  type WalletKind,
  type WalletStatus,
} from "../../db/entities";

export class CreateWalletDto {
  /**
   * The caller's own identifier. Optional, but supplying one makes wallet creation idempotent in
   * the way that matters: a retry that reaches us twice cannot mint two wallets for one customer,
   * because the unique index on `lower(external_id)` refuses the second.
   */
  @ApiPropertyOptional({ maxLength: 128, example: "customer-12345" })
  @IsOptional()
  @IsExternalId()
  externalId?: string;

  /** Free text for the backoffice UI. Not used for lookup. */
  @ApiPropertyOptional({ maxLength: 200, example: "Ada Lovelace" })
  @IsOptional()
  @IsLabel()
  label?: string;
}

export class UpdateWalletDto {
  @ApiPropertyOptional({ maxLength: 200, example: "Ada Lovelace (closed)" })
  @IsOptional()
  @IsLabel()
  label?: string;

  /**
   * `provisioning` is not settable: it describes a fact about the upstream, not an intent, and
   * moving a wallet back into it by hand would make the reconcile sweep chase an address that is
   * already confirmed.
   *
   * A disabled wallet cannot sign, but its address still counts as the platform's — funds may sit
   * there, and forgetting it would turn an internal transfer into an external one.
   */
  @ApiPropertyOptional({ enum: ["active", "disabled"], example: "disabled" })
  @IsOptional()
  @IsIn(WALLET_STATUSES.filter((status) => status !== "provisioning"))
  status?: Exclude<WalletStatus, "provisioning">;
}

export class ListWalletsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: WALLET_KINDS })
  @IsOptional()
  @IsIn([...WALLET_KINDS])
  kind?: WalletKind;

  @ApiPropertyOptional({ enum: WALLET_STATUSES })
  @IsOptional()
  @IsIn([...WALLET_STATUSES])
  status?: WalletStatus;

  /** Case-insensitive substring match over ref, external id, label and both addresses. */
  @ApiPropertyOptional({ example: "customer-123" })
  @IsOptional()
  @Trimmed()
  q?: string;
}

export class DpmRegisteredDto {
  /**
   * Defaults to true, so a caller can confirm a registration with an empty body. The stored flag
   * mirrors what dpm-wallet reports back, not what this asked for.
   */
  @ApiPropertyOptional({ default: true, example: true })
  @IsOptional()
  registered: boolean = true;
}
