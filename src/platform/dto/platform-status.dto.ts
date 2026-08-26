import { ApiProperty } from "@nestjs/swagger";

import { PLATFORM_MODES } from "../../config";
import { WalletResponseDto } from "../../wallets/dto/wallet-response.dto";

export class UpstreamVaultDto {
  /** False until `POST /v1/vault/init` has been run on dpm-wallet. */
  @ApiProperty({ example: true })
  initialized!: boolean;

  /** Whether dpm-wallet can reach its custody backend. */
  @ApiProperty({ example: true })
  ready!: boolean;
}

export class UpstreamStatusDto {
  /**
   * False when dpm-wallet did not answer. Reported rather than raised: the reason to call this
   * endpoint is to find out that the upstream is down, so a 502 here would be useless.
   */
  @ApiProperty({ example: true })
  reachable!: boolean;

  @ApiProperty({ type: UpstreamVaultDto, required: false })
  vault?: UpstreamVaultDto;
}

/** Everything a backoffice landing page needs, in one call. */
export class PlatformStatusDto {
  /**
   * The custody mode. Fixed on this install's first boot and immutable afterwards — a container
   * whose environment disagrees with it refuses to start.
   */
  @ApiProperty({ enum: PLATFORM_MODES, example: "shared" })
  mode!: string;

  /** When the mode was burned in. */
  @ApiProperty({ type: String, format: "date-time", nullable: true })
  modeBurnedAt!: string | null;

  /** The only wallet funds may leave the platform from. Null until an admin creates it. */
  @ApiProperty({ type: WalletResponseDto, nullable: true })
  masterWallet!: WalletResponseDto | null;

  /** In shared mode, the treasury that makes every BUY and receives every SELL. */
  @ApiProperty({ type: WalletResponseDto, nullable: true })
  operationsWallet!: WalletResponseDto | null;

  /** Every wallet in the directory, including the two platform ones and any disabled. */
  @ApiProperty({ example: 128 })
  walletCount!: number;

  @ApiProperty({ type: UpstreamStatusDto })
  upstream!: UpstreamStatusDto;
}
