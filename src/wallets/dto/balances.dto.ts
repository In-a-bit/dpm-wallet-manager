import { ApiProperty } from "@nestjs/swagger";
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from "class-validator";

export class WalletBalancesRequestDto {
  /** Wallet ids, as returned by POST /v1/wallets. Answered in this order. */
  @ApiProperty({ type: [String], format: "uuid", minItems: 1, maxItems: 100 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsUUID("all", { each: true })
  walletIds!: string[];
}

export class WalletBalanceDto {
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  /** The address the funds sit at, and the one the balance was read for. */
  @ApiProperty({ example: "0x0000000000000000000000000000000000000001" })
  proxyAddress!: string;

  /** Collateral in micro-USDC (6 decimals), as a decimal string. */
  @ApiProperty({ example: "1500000" })
  balanceMicro!: string;

  /** The chain block the balance was read at; null for a wallet the data-api has not synced. */
  @ApiProperty({ type: Number, nullable: true })
  blockNumber!: number | null;
}
