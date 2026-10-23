import { ApiProperty } from "@nestjs/swagger";

/** A withdrawal signed and handed to relayer-api; the signature itself is never returned. */
export class TransferResponseDto {
  /** The row in the artefact log, as `GET /v1/operations` lists it. */
  @ApiProperty({ format: "uuid" })
  operationId!: string;

  /** relayer-api's id for the submission; pass it to `GET /v1/transfers/{relayerTransactionId}`. */
  @ApiProperty({ example: "0b7e1c2a-5d3f-4f0e-9a43-3c1f2d8e6b10" })
  relayerTransactionId!: string;

  /** The relayer's state at submission, verbatim — usually `STATE_NEW`. */
  @ApiProperty({ type: String, nullable: true, example: "STATE_NEW" })
  state!: string | null;

  /** True when the funds left the platform, which only the master wallet with an admin key can do. */
  @ApiProperty({ example: false })
  external!: boolean;
}

/** relayer-api's current view of a relayed transfer. */
export class TransferStatusDto {
  @ApiProperty({ example: "0b7e1c2a-5d3f-4f0e-9a43-3c1f2d8e6b10" })
  relayerTransactionId!: string;

  /** The relayer's state, verbatim — e.g. `STATE_NEW`, `STATE_MINED`, `STATE_CONFIRMED`. */
  @ApiProperty({ type: String, nullable: true, example: "STATE_MINED" })
  state!: string | null;

  /** The on-chain hash, once the relayer has broadcast it. */
  @ApiProperty({ type: String, nullable: true, example: `0x${"ab".repeat(32)}` })
  transactionHash!: string | null;
}
