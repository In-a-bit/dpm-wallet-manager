import { ApiProperty } from "@nestjs/swagger";

import { WalletResponseDto } from "./wallet-response.dto";

export class WalletPageDto {
  @ApiProperty({ type: [WalletResponseDto] })
  items!: WalletResponseDto[];

  /** Rows matching the filter, ignoring the page window. */
  @ApiProperty({ example: 128 })
  total!: number;

  @ApiProperty({ example: 50 })
  limit!: number;

  @ApiProperty({ example: 0 })
  offset!: number;
}

/** The EOA and its proof of control, for registering the address with the DPM platform. */
export class DpmAttestationDto {
  /**
   * The wallet's externally-owned address. Not the proxy: registration attests to control of the
   * key, and the key is the EOA's.
   */
  @ApiProperty({ example: "0x26AE3209AC2D7f954db04Ee0Dfe14D3fEEF352Fd" })
  address!: string;

  /**
   * An EIP-191 signature over the platform's fixed attestation message. The private key never
   * leaves dpm-wallet, so proof of control is the only thing that can be handed over.
   */
  @ApiProperty({ example: "0x9f2c…1b" })
  signature!: string;
}
