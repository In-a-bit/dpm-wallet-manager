/**
 * The dpm-wallet contract, as this service depends on it.
 *
 * Declared here rather than imported from `@inabit-com/dpm-sdk/server` on purpose. Under
 * sign-only passthrough this service never builds or signs anything — it shapes a request,
 * forwards it, and returns what comes back — so taking the SDK as a dependency would buy nothing
 * and cost the vendored build, a React-adjacent import graph, and a version coupling to the
 * EIP-712 domain. What it does cost is a contract that can drift silently, which the contract
 * test in `test/upstream-contract.e2e-spec.ts` is there to catch.
 */

export type UpstreamAddress = {
  ref: string;
  index: number;
  address: string;
  proxyAddress: string;
  dpmRegistered: boolean;
  createdAt: string;
};

export type UpstreamAddressPage = {
  addresses: UpstreamAddress[];
  total: number;
  limit: number;
  offset: number;
};

/** The EOA and its proof of control, for registering the address with the DPM platform. */
export type UpstreamAttestation = {
  address: string;
  signature: string;
};

/** The 13 signed fields, in the order the exchange hashes them. */
export type UpstreamOrder = {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  recipient: string;
  tokenId: string;
  makerAmount: string;
  takerAmount: string;
  expiration: string;
  nonce: string;
  feeRateBps: string;
  side: 0 | 1;
  signatureType: number;
};

export type UpstreamSignedOrder = {
  order: UpstreamOrder;
  signature: string;
  orderHash: string;
};

export type UpstreamSignedCancel = {
  orderHash: string;
  message: string;
  signature: string;
};

/** What the caller POSTs verbatim to relayer-api `/submit`. */
export type UpstreamSubmitTransactionRequest = {
  from: string;
  to: string;
  proxyWallet?: string;
  data: string;
  nonce: string;
  signature: string;
  signatureParams: {
    gasPrice?: string;
    relayerFee?: string;
    gasLimit?: string;
    relayHub?: string;
    relay?: string;
  };
  type: "PROXY";
  metadata?: string;
};

export type UpstreamSignOrderRequest = {
  ref: string;
  maker: string;
  side: 0 | 1;
  tokenId: string;
  shares: number;
  price: number;
  feeRateBps: number;
  /** Omitted entirely — not sent as zero — when the exchange should pay the maker. */
  recipient?: string;
};

export type UpstreamMetaTxKind = "allowance" | "redeem" | "split" | "merge" | "withdraw";

export type UpstreamMetaTxRequest = {
  ref: string;
  conditionId?: string;
  amountDecimal?: string;
  recipient?: string;
};

export type UpstreamHealth = {
  status: string;
  vault?: { mode: string; initialized: boolean; ready: boolean };
};
