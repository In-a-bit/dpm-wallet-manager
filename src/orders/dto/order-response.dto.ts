import { ApiProperty } from "@nestjs/swagger";

import { PLATFORM_MODES } from "../../config";
import { BUY, SELL } from "../order-routing";

/**
 * The 13 signed fields, in the order the exchange hashes them. Reordering or omitting one yields
 * a signature the exchange rejects, so this mirrors dpm-wallet's struct exactly.
 */
export class SignedOrderFieldsDto {
  @ApiProperty({ description: "uint256", example: "1" })
  salt!: string;

  /** The source of funds. Decided by this service from the custody mode, not by the caller. */
  @ApiProperty({ example: "0xc4D5f4AB19e60cff0B5E19D93B045d183Dfa5352" })
  maker!: string;

  /** The EOA whose key signed. In shared mode this is the treasury's, not the caller's wallet. */
  @ApiProperty({ example: "0x26AE3209AC2D7f954db04Ee0Dfe14D3fEEF352Fd" })
  signer!: string;

  /** The zero address for a public order. */
  @ApiProperty({ example: "0x0000000000000000000000000000000000000000" })
  taker!: string;

  /**
   * Who receives the proceeds. The zero address means the exchange pays the maker, which is how
   * an omitted recipient is encoded on-chain.
   */
  @ApiProperty({ example: "0x0000000000000000000000000000000000000000" })
  recipient!: string;

  @ApiProperty({ description: "uint256", example: "71321045679252212594626385532706912750" })
  tokenId!: string;

  /** 6-decimal micro-units. Collateral on a BUY, shares on a SELL. */
  @ApiProperty({ example: "40000000" })
  makerAmount!: string;

  /** 6-decimal micro-units. Shares on a BUY, collateral on a SELL. */
  @ApiProperty({ example: "100000000" })
  takerAmount!: string;

  /** A unix timestamp, or `"0"` for an order that does not expire. */
  @ApiProperty({ example: "0" })
  expiration!: string;

  /** The maker's exchange nonce, not the RelayHub one. */
  @ApiProperty({ example: "0" })
  nonce!: string;

  /** Basis points, so `"200"` is 2%. */
  @ApiProperty({ example: "200" })
  feeRateBps!: string;

  /** `0` buys, `1` sells. */
  @ApiProperty({ enum: [BUY, SELL], example: BUY })
  side!: 0 | 1;

  /** `1` is POLY_PROXY. */
  @ApiProperty({ example: 1 })
  signatureType!: number;
}

/**
 * What this service decided on the caller's behalf, and why.
 *
 * Present on every order because in shared mode the caller asked for "wallet X buys" and got back
 * an order whose maker is a different address. That has to be visible, or the first person to read
 * the signed order will file a bug.
 */
export class OrderRoutingDto {
  /** The custody mode that produced this decision. */
  @ApiProperty({ enum: PLATFORM_MODES, example: "shared" })
  mode!: string;

  /** `0` buys, `1` sells. */
  @ApiProperty({ enum: [BUY, SELL], example: BUY })
  side!: 0 | 1;

  /** The wallet the caller named. */
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  /** The wallet whose key actually signed — not the same thing, in shared mode. */
  @ApiProperty({ format: "uuid" })
  signerWalletId!: string;

  /** The proxy address whose funds this order spends. */
  @ApiProperty({ example: "0xc4D5f4AB19e60cff0B5E19D93B045d183Dfa5352" })
  maker!: string;

  /** Null when the exchange pays the maker. */
  @ApiProperty({ type: String, nullable: true })
  recipient!: string | null;
}

export class SignedOrderResponseDto {
  @ApiProperty({ type: SignedOrderFieldsDto })
  order!: SignedOrderFieldsDto;

  /** EIP-712 signature over the order. Post it to the CLOB with the order; this service does not. */
  @ApiProperty({ example: "0x9f2c…1b" })
  signature!: string;

  /** Also the handle `POST /v1/wallets/{id}/orders/cancel` takes. */
  @ApiProperty({ example: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045…" })
  orderHash!: string;

  @ApiProperty({ type: OrderRoutingDto })
  routing!: OrderRoutingDto;

  /** The row in `GET /v1/operations` recording this signature. */
  /** The row in `GET /v1/operations` recording this signature. */
  @ApiProperty({ format: "uuid" })
  operationId!: string;
}

export class SignedCancelResponseDto {
  /** The order being cancelled, echoed back. */
  @ApiProperty({ example: "0x4d97dcd97ec945f40cf65f87097ace5ea0476045…" })
  orderHash!: string;

  /** The plaintext that was signed, EIP-191. */
  @ApiProperty({ example: "Cancel order: 0x4d97… on market: 0x1234…" })
  message!: string;

  /** EIP-191 signature over the message above. */
  @ApiProperty({ example: "0x9f2c…1b" })
  signature!: string;

  /** The wallet the caller named. */
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  /**
   * Whoever signed the original order, looked up in this install's own ledger — in shared mode a
   * BUY was signed by the treasury, and a cancel signed by the user would carry the wrong signer.
   */
  @ApiProperty({ format: "uuid" })
  signerWalletId!: string;

  @ApiProperty({ format: "uuid" })
  operationId!: string;
}
