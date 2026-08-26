import type { Address } from "viem";

import type { PlatformMode } from "../config";
import type { ReadyWallet } from "../db/repositories/wallet.repo";

export const BUY = 0;
export const SELL = 1;
export type OrderSide = typeof BUY | typeof SELL;

export type RoutingInput = {
  mode: PlatformMode;
  side: OrderSide;
  /** The wallet the caller named — always the user-facing one, in either mode. */
  wallet: ReadyWallet;
  /** Required in shared mode; ignored in segregated. */
  operationsWallet?: ReadyWallet | undefined;
};

export type OrderRouting = {
  mode: PlatformMode;
  side: OrderSide;
  /** The wallet whose key signs. Its EOA becomes the order's `signer`. */
  signer: ReadyWallet;
  /** The source of funds. Always a proxy address. */
  maker: Address;
  /** Where proceeds go. Undefined means "pay the maker", which is how it is sent upstream. */
  recipient: Address | undefined;
};

/**
 * Decides who signs, who funds, and who is paid. This is the one thing this service does that is
 * not a passthrough, and it is the reason it exists.
 *
 * The invariant underneath every row below: **the maker is always the source of funds**, and the
 * recipient receives proceeds only. The exchange debits the maker and credits
 * `recipient == 0 ? maker : recipient`. So the question "who makes?" is really "whose money is
 * being spent?", and the mode is the answer.
 *
 * | mode        | side | signs      | maker (funds)  | recipient (proceeds) |
 * | ----------- | ---- | ---------- | -------------- | -------------------- |
 * | segregated  | BUY  | user       | user proxy     | — (the maker)        |
 * | segregated  | SELL | user       | user proxy     | — (the maker)        |
 * | shared      | BUY  | operations | operations     | user proxy           |
 * | shared      | SELL | user       | user proxy     | operations proxy     |
 *
 * In segregated mode each wallet holds its own USDC and its own tokens, so it is both the source
 * and the destination and no recipient is needed at all.
 *
 * In shared mode the operations wallet holds every dollar of collateral. A BUY spends USDC, so
 * operations must be the maker — and the tokens bought have to be credited to the user, which is
 * what the recipient is for. A SELL spends tokens, which the user holds, so the user makes; the
 * USDC that comes back belongs to the treasury, so operations is the recipient.
 *
 * Pure by design: no repository, no upstream, no clock. Every branch is a table row, and the
 * table is what the tests enumerate.
 */
export function routeOrder(input: RoutingInput): OrderRouting {
  const { mode, side, wallet } = input;

  if (mode === "segregated") {
    // No recipient at all, per the design: an unset recipient means the exchange pays the maker,
    // which is exactly right when the maker already owns both sides of the trade.
    return { mode, side, signer: wallet, maker: wallet.proxyAddress, recipient: undefined };
  }

  const operations = input.operationsWallet;
  if (!operations) {
    // The caller is responsible for supplying it; reaching here is a wiring bug rather than a
    // client error, and the service turns the missing wallet into OPERATIONS_WALLET_REQUIRED
    // before it ever calls this.
    throw new Error("shared mode routing requires the operations wallet");
  }

  if (side === BUY) {
    // Operations pays; the user receives the tokens. When the caller *is* operations, maker and
    // recipient would be the same address — send no recipient rather than a redundant one, so the
    // signed order is identical to the equivalent segregated one.
    const recipient = sameWallet(wallet, operations) ? undefined : wallet.proxyAddress;
    return { mode, side, signer: operations, maker: operations.proxyAddress, recipient };
  }

  // SELL: the user holds the tokens, so the user makes; the collateral is swept to the treasury.
  const recipient = sameWallet(wallet, operations) ? undefined : operations.proxyAddress;
  return { mode, side, signer: wallet, maker: wallet.proxyAddress, recipient };
}

function sameWallet(left: ReadyWallet, right: ReadyWallet): boolean {
  return left.id === right.id;
}
