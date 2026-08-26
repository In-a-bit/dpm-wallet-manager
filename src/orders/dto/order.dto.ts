import { ApiProperty } from "@nestjs/swagger";
import { IsIn, IsInt, IsNumber, IsPositive, IsString, Max, Min, MinLength } from "class-validator";

import { IsCtfTokenId, IsOrderHash, Trimmed } from "../../common/validation/decorators";
import { BUY, SELL, type OrderSide } from "../order-routing";

const MAX_FEE_RATE_BPS = 10_000;

/**
 * Deliberately small. A caller says what it wants to trade and for how much; it does **not** say
 * who makes, who signs, or who is paid — those are derived from the custody mode, and letting a
 * caller supply them would put the one decision this service exists to make back in their hands.
 *
 * Anything extra in the body is stripped by the validation pipe rather than honoured, so a
 * `maker` or `recipient` sent by a hopeful client changes nothing.
 *
 * The schema hints below are explicit because the shared validation decorators are composites,
 * which the OpenAPI plugin's class-validator shim cannot see through.
 */
export class SignOrderDto {
  /** `0` buys, `1` sells. Strictly the numbers; the string `"0"` is rejected, matching dpm-wallet. */
  @ApiProperty({ enum: [BUY, SELL], example: BUY })
  @IsIn([BUY, SELL])
  side!: OrderSide;

  /** The CTF token id, as a decimal string — it does not fit in a JSON number. */
  @ApiProperty({
    pattern: "^\\d+$",
    example: "71321045679252212594626385532706912750332728571942532289631379312455583992563",
  })
  @IsCtfTokenId()
  tokenId!: string;

  /** Whole or fractional shares. Converted to 6-decimal micro-units upstream. */
  @ApiProperty({ exclusiveMinimum: true, minimum: 0, example: 100 })
  @IsNumber()
  @IsPositive()
  shares!: number;

  /** A probability: strictly greater than 0 and at most 1. */
  @ApiProperty({ exclusiveMinimum: true, minimum: 0, maximum: 1, example: 0.4 })
  @IsNumber()
  @IsPositive()
  @Max(1)
  price!: number;

  /** Basis points, so 200 is 2%. */
  @ApiProperty({ minimum: 0, maximum: MAX_FEE_RATE_BPS, example: 200 })
  @IsInt()
  @Min(0)
  @Max(MAX_FEE_RATE_BPS)
  feeRateBps!: number;
}

export class SignCancelDto {
  /** The hash returned when the order was signed. */
  @ApiProperty({ pattern: "^0x[0-9a-fA-F]{64}$", example: `0x${"4d".repeat(32)}` })
  @IsOrderHash()
  orderHash!: string;

  /** The market the order sits on. Signed into the cancel message verbatim. */
  @ApiProperty({ minLength: 1, example: "0x1234abcd" })
  @Trimmed()
  @IsString()
  @MinLength(1)
  marketId!: string;
}
