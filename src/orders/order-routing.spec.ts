import type { Address } from "viem";

import type { ReadyWallet } from "../db/repositories/wallet.repo";
import { BUY, routeOrder, SELL } from "./order-routing";

/**
 * Every cell of the routing table, plus the two degenerate cases.
 *
 * Exhaustive on purpose: this function decides whose money is spent on every order the platform
 * ever signs, and a wrong cell would not fail loudly — it would produce a perfectly valid order
 * that moves the wrong wallet's funds.
 */
const USER_PROXY = "0x1111111111111111111111111111111111111111" as Address;
const OPS_PROXY = "0x2222222222222222222222222222222222222222" as Address;

const wallet = (id: string, proxyAddress: Address, kind: ReadyWallet["kind"]): ReadyWallet => ({
  id,
  ref: `mgr:${id}`,
  kind,
  externalId: null,
  label: null,
  status: "active",
  eoaAddress: "0x3333333333333333333333333333333333333333",
  proxyAddress,
  derivationIndex: 0,
  dpmRegistered: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const user = wallet("user-1", USER_PROXY, "user");
const operations = wallet("ops-1", OPS_PROXY, "operations");

describe("routeOrder", () => {
  describe("segregated mode", () => {
    it.each([
      ["BUY", BUY],
      ["SELL", SELL],
    ] as const)("has the user sign, make and be paid on a %s", (_name, side) => {
      const routing = routeOrder({ mode: "segregated", side, wallet: user });
      expect(routing).toEqual({
        mode: "segregated",
        side,
        signer: user,
        maker: USER_PROXY,
        // Never a recipient: the wallet already owns both sides of the trade.
        recipient: undefined,
      });
    });

    it("ignores an operations wallet even when one exists", () => {
      const routing = routeOrder({
        mode: "segregated",
        side: BUY,
        wallet: user,
        operationsWallet: operations,
      });
      expect(routing.maker).toBe(USER_PROXY);
      expect(routing.recipient).toBeUndefined();
    });
  });

  describe("shared mode", () => {
    it("has operations fund a BUY and pays the tokens to the user", () => {
      const routing = routeOrder({
        mode: "shared",
        side: BUY,
        wallet: user,
        operationsWallet: operations,
      });
      expect(routing.signer).toBe(operations);
      expect(routing.maker).toBe(OPS_PROXY);
      expect(routing.recipient).toBe(USER_PROXY);
    });

    it("has the user fund a SELL and sweeps the collateral to operations", () => {
      const routing = routeOrder({
        mode: "shared",
        side: SELL,
        wallet: user,
        operationsWallet: operations,
      });
      expect(routing.signer).toBe(user);
      expect(routing.maker).toBe(USER_PROXY);
      expect(routing.recipient).toBe(OPS_PROXY);
    });

    it.each([
      ["BUY", BUY],
      ["SELL", SELL],
    ] as const)("sends no recipient when operations trades for itself on a %s", (_name, side) => {
      const routing = routeOrder({
        mode: "shared",
        side,
        wallet: operations,
        operationsWallet: operations,
      });
      // Maker and recipient would be the same address; an omitted recipient means exactly that
      // to the exchange, and keeps the signed order identical to the segregated equivalent.
      expect(routing.maker).toBe(OPS_PROXY);
      expect(routing.recipient).toBeUndefined();
      expect(routing.signer).toBe(operations);
    });

    it("refuses to route without the operations wallet rather than guessing", () => {
      expect(() => routeOrder({ mode: "shared", side: BUY, wallet: user })).toThrow(
        /requires the operations wallet/,
      );
    });
  });

  it("never names a wallet's EOA as maker or recipient — funds live at the proxy", () => {
    for (const mode of ["segregated", "shared"] as const) {
      for (const side of [BUY, SELL] as const) {
        const routing = routeOrder({ mode, side, wallet: user, operationsWallet: operations });
        expect(routing.maker).not.toBe(user.eoaAddress);
        expect(routing.recipient).not.toBe(user.eoaAddress);
      }
    }
  });
});
