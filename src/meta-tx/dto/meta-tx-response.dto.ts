import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

export class MetaTxSignatureParamsDto {
  @ApiPropertyOptional({ example: "0" })
  gasPrice?: string;

  @ApiPropertyOptional({ example: "0" })
  relayerFee?: string;

  @ApiPropertyOptional({ example: "300000" })
  gasLimit?: string;

  @ApiPropertyOptional({ example: "0xD216153c06e857Cd7F72665e0aF1D7d82172f495" })
  relayHub?: string;

  /** The relayer admin address, fetched from relayer-api at signing time. */
  @ApiPropertyOptional({ example: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052" })
  relay?: string;
}

/**
 * A complete GSN/RelayHub meta-transaction, ready to POST verbatim to relayer-api's `/submit`.
 *
 * This service signs it and hands it back; broadcasting is the caller's step. The three extra
 * fields at the bottom are ours — everything above them is the relayer's own request shape.
 */
export class MetaTxResponseDto {
  /** The wallet's EOA, which signed the `rlx:` struct hash. */
  @ApiProperty({ example: "0x26AE3209AC2D7f954db04Ee0Dfe14D3fEEF352Fd" })
  from!: string;

  /** The proxy factory. */
  @ApiProperty({ example: "0xaB45c5A4B0c941a2F231C04C3f49182e1A254052" })
  to!: string;

  /** The proxy the calls execute through — where the funds actually are. */
  @ApiPropertyOptional({ example: "0xc4D5f4AB19e60cff0B5E19D93B045d183Dfa5352" })
  proxyWallet?: string;

  /** ABI-encoded `proxy(ProxyCall[])`. */
  @ApiProperty({ example: "0x1f8b…" })
  data!: string;

  /** The RelayHub nonce, resolved from the DPM platform's user table at signing time. */
  @ApiProperty({ example: "0" })
  nonce!: string;

  /** EIP-191 signature over the `rlx:` struct hash, by the wallet's EOA. */
  @ApiProperty({ example: "0x9f2c…1b" })
  signature!: string;

  @ApiProperty({ type: MetaTxSignatureParamsDto })
  signatureParams!: MetaTxSignatureParamsDto;

  /** Always `PROXY`; the relayer rejects `SAFE` on this route. */
  @ApiProperty({ enum: ["PROXY"], example: "PROXY" })
  type!: "PROXY";

  /** A human label the relayer records alongside the transaction. */
  @ApiPropertyOptional({ example: "approve USDC + setApprovalForAll CTF exchange" })
  metadata?: string;

  /** The wallet the funds move from. */
  @ApiProperty({ format: "uuid" })
  walletId!: string;

  /** The row in `GET /v1/operations` recording this signature. */
  @ApiProperty({ format: "uuid" })
  operationId!: string;

  /**
   * True when this moves funds off the platform — which only the master wallet, with an admin
   * key, can do. Mirrors the `meta.withdraw.external` audit event.
   */
  @ApiProperty({ example: false })
  external!: boolean;
}
