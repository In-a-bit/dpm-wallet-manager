import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional } from "class-validator";

import {
  IsConditionId,
  IsDecimalAmount,
  IsEvmAddress,
  IsUuid,
} from "../../common/validation/decorators";

const CONDITION_ID = {
  pattern: "^0x[0-9a-fA-F]{64}$",
  example: `0x${"7a".repeat(32)}`,
  description: "The CTF condition this position belongs to.",
} as const;

const AMOUNT = {
  pattern: "^\\d+(\\.\\d{1,18})?$",
  example: "10.50",
  description: "A positive decimal amount of USDC, as a string. Not a number — precision matters.",
} as const;

const RECIPIENT = {
  description:
    "A raw destination address. Supply this **or** `recipientWalletId`, never both. An address " +
    "outside this platform's directory is refused unless the source is the master wallet and the " +
    "caller holds an admin key.",
  example: "0xc4D5f4AB19e60cff0B5E19D93B045d183Dfa5352",
} as const;

const RECIPIENT_WALLET = {
  format: "uuid",
  description:
    "A wallet in this directory, resolved to its **proxy** address — where funds live. Prefer " +
    "this for internal movement: it needs no address lookup, and it is self-evidently internal, " +
    "which removes a class of typo that would otherwise be refused as an external transfer.",
} as const;

/**
 * Each kind admits only its own arguments, so a request carrying the wrong one for its kind is
 * stripped or rejected by the pipe rather than reaching the builder and being silently ignored.
 *
 * The inheritance mirrors how the upstream layers them: a condition on top of nothing, and then
 * redeem and split diverge — only redeem takes a recipient. Allowance has no body at all.
 */
export class MetaTxConditionDto {
  @ApiProperty(CONDITION_ID)
  @IsConditionId()
  conditionId!: string;
}

export class MetaTxRedeemDto extends MetaTxConditionDto {
  /**
   * Omit both recipient fields to leave the redeemed collateral in the proxy wallet. Setting one
   * makes this a transfer: the upstream quotes the payout from the relayer and forwards exactly
   * that much in the same proxy transaction, so it is subject to the funds policy.
   */
  @ApiPropertyOptional(RECIPIENT)
  @IsOptional()
  @IsEvmAddress()
  recipient?: string;

  @ApiPropertyOptional(RECIPIENT_WALLET)
  @IsOptional()
  @IsUuid()
  recipientWalletId?: string;
}

/** Split and merge take the same arguments. */
export class MetaTxSplitDto extends MetaTxConditionDto {
  @ApiProperty(AMOUNT)
  @IsDecimalAmount()
  amountDecimal!: string;
}

export class MetaTxWithdrawDto {
  /** Required, in one form or the other: a withdrawal with no destination is meaningless. */
  @ApiPropertyOptional(RECIPIENT)
  @IsOptional()
  @IsEvmAddress()
  recipient?: string;

  @ApiPropertyOptional(RECIPIENT_WALLET)
  @IsOptional()
  @IsUuid()
  recipientWalletId?: string;

  @ApiProperty(AMOUNT)
  @IsDecimalAmount()
  amountDecimal!: string;
}
