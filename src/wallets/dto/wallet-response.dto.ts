import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";

import { WALLET_KINDS, WALLET_STATUSES } from "../../db/entities";
import type { Wallet } from "../../db/repositories/wallet.repo";

/**
 * What a caller sees. Deliberately not the stored row: `derivationIndex` is dpm-wallet's concept,
 * and exposing it would invite a caller to address wallets by it and couple itself to the upstream
 * naming this service exists to hide.
 *
 * `ref` is included anyway, read-only, because support cannot correlate a wallet here with a
 * wallet there without it.
 */
export class WalletResponseDto {
  /** The id every other endpoint takes. Minted here, not by dpm-wallet. */
  @ApiProperty({ format: "uuid", example: "b7b834cf-f233-4d77-ad65-4a55409f2248" })
  id!: string;

  /**
   * `user` for an ordinary wallet; `master` and `operations` are the two singletons created
   * through `/v1/platform`.
   */
  @ApiProperty({ enum: WALLET_KINDS, example: "user" })
  kind!: string;

  /** The caller's own identifier, if one was supplied. Unique case-insensitively. */
  @ApiProperty({ type: String, nullable: true, example: "customer-12345" })
  externalId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: "Ada Lovelace" })
  label!: string | null;

  /**
   * `provisioning` means the row exists but dpm-wallet has not confirmed an address yet — every
   * signing route refuses it until `POST /v1/wallets/{id}/reconcile` succeeds.
   */
  @ApiProperty({ enum: WALLET_STATUSES, example: "active" })
  status!: string;

  /** The externally-owned address. Null only while provisioning. */
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0x26AE3209AC2D7f954db04Ee0Dfe14D3fEEF352Fd",
  })
  address!: string | null;

  /**
   * The proxy wallet, derived by dpm-wallet with CREATE2. **This is where funds live** — orders
   * name it as maker and recipient, and transfers should be addressed to it, not to `address`.
   */
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0xc4D5f4AB19e60cff0B5E19D93B045d183Dfa5352",
  })
  proxyAddress!: string | null;

  /**
   * Whether the DPM platform has registered this wallet's EOA. Every meta-transaction depends on
   * it: the RelayHub nonce is resolved from the platform's user table.
   */
  @ApiProperty({ example: false })
  dpmRegistered!: boolean;

  /** What dpm-wallet knows this wallet as. Read-only, and only useful for support. */
  @ApiProperty({ example: "mgr:b7b834cf-f233-4d77-ad65-4a55409f2248" })
  ref!: string;

  @ApiProperty({ format: "date-time" })
  createdAt!: string;

  @ApiProperty({ format: "date-time" })
  updatedAt!: string;
}

/**
 * A platform wallet, which may carry a note. Segregated installs may still create an operations
 * wallet — the endpoint says it is unused rather than refusing, so one provisioning script works
 * for both deployments.
 */
export class PlatformWalletResponseDto extends WalletResponseDto {
  /** Present only when there is something about this wallet the caller should know. */
  @ApiPropertyOptional({
    example: "This install runs in segregated mode; the operations wallet is unused.",
  })
  note?: string;
}

export function toWalletResponse(wallet: Wallet): WalletResponseDto {
  return {
    id: wallet.id,
    kind: wallet.kind,
    externalId: wallet.externalId,
    label: wallet.label,
    status: wallet.status,
    address: wallet.eoaAddress,
    proxyAddress: wallet.proxyAddress,
    dpmRegistered: wallet.dpmRegistered,
    ref: wallet.ref,
    createdAt: wallet.createdAt,
    updatedAt: wallet.updatedAt,
  };
}
