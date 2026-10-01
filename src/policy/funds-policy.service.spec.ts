import type { Actor } from "../common/actor";
import type { Wallet } from "../db/repositories/wallet.repo";
import { ManagerError } from "../errors";
import { FundsPolicyService, type PolicyAction } from "./funds-policy.service";

/**
 * Every branch of the one rule that guards the platform's money, allowed and denied.
 *
 * Written against fakes rather than the harness on purpose: this is a decision table, and it
 * should be readable as one. The end-to-end spec proves the table is actually reached.
 */
const PLATFORM_ADDRESS = "0x1111111111111111111111111111111111111111";
const EXTERNAL_ADDRESS = "0x000000000000000000000000000000000000dEaD";

const wallet = (kind: Wallet["kind"]): Wallet =>
  ({ id: `${kind}-1`, kind, status: "active" }) as Wallet;

const actor = (role: Actor["role"]): Actor => ({
  keyId: `${role}-key`,
  userId: null,
  username: null,
  role,
  prefix: `dpmm_test_${role.slice(0, 2)}`,
  name: role,
});

describe("FundsPolicyService", () => {
  const recorded: { action: string; outcome: string }[] = [];
  const audit = {
    record: jest.fn(async (entry: { action: string; outcome: string }) => {
      recorded.push({ action: entry.action, outcome: entry.outcome });
    }),
  };
  const wallets = {
    isPlatformAddress: jest.fn(
      async (address: string) => address.toLowerCase() === PLATFORM_ADDRESS.toLowerCase(),
    ),
  };
  const policy = new FundsPolicyService(wallets as never, audit as never);

  beforeEach(() => {
    recorded.length = 0;
    jest.clearAllMocks();
  });

  const assert = (
    action: PolicyAction,
    kind: Wallet["kind"],
    role: Actor["role"],
    recipient?: string,
  ) => policy.assert({ action, wallet: wallet(kind), actor: actor(role), recipient });

  describe("actions that move nothing", () => {
    it.each(["allowance", "split", "merge", "redeem"] as const)(
      "permits %s for a user wallet with an operator key",
      async (action) => {
        await expect(assert(action, "user", "operator")).resolves.toEqual({ external: false });
        // Nothing left the platform, so nothing is recorded as if it had.
        expect(recorded).toHaveLength(0);
      },
    );

    it("permits them for the operations wallet too", async () => {
      await expect(assert("allowance", "operations", "operator")).resolves.toEqual({
        external: false,
      });
    });
  });

  describe("the master wallet", () => {
    it.each(["order", "cancel"] as const)("cannot %s", async (action) => {
      await expect(assert(action, "master", "admin")).rejects.toMatchObject({
        code: "MASTER_WALLET_CANNOT_TRADE",
        status: 403,
      });
    });

    it("cannot be given an allowance, even by an admin", async () => {
      await expect(assert("allowance", "master", "admin")).rejects.toMatchObject({
        code: "MASTER_ALLOWANCE_FORBIDDEN",
      });
    });

    it("can still split, merge and redeem", async () => {
      await expect(assert("split", "master", "operator")).resolves.toEqual({ external: false });
    });
  });

  describe("internal transfers", () => {
    it.each(["user", "operations", "master"] as const)(
      "are unrestricted from a %s wallet with an operator key",
      async (kind) => {
        await expect(assert("withdraw", kind, "operator", PLATFORM_ADDRESS)).resolves.toEqual({
          external: false,
        });
      },
    );

    it("match a platform address whatever its casing", async () => {
      await expect(
        assert("withdraw", "user", "operator", PLATFORM_ADDRESS.toUpperCase()),
      ).resolves.toEqual({ external: false });
    });

    it("apply to a redeem that forwards its payout", async () => {
      await expect(assert("redeem", "user", "operator", PLATFORM_ADDRESS)).resolves.toEqual({
        external: false,
      });
    });
  });

  describe("external transfers", () => {
    it.each([
      ["user", "operator"],
      ["user", "admin"],
      ["operations", "operator"],
      ["operations", "admin"],
    ] as const)("are refused from a %s wallet with a %s key", async (kind, role) => {
      await expect(assert("withdraw", kind, role, EXTERNAL_ADDRESS)).rejects.toMatchObject({
        code: "EXTERNAL_TRANSFER_FORBIDDEN",
        status: 403,
      });
      expect(recorded).toEqual([{ action: "meta.withdraw", outcome: "denied" }]);
    });

    it("are refused from the master wallet with an operator key", async () => {
      const error = await assert("withdraw", "master", "operator", EXTERNAL_ADDRESS).catch(
        (err: unknown) => err,
      );
      expect((error as ManagerError).code).toBe("EXTERNAL_TRANSFER_FORBIDDEN");
      expect((error as ManagerError).message).toMatch(/admin key/);
    });

    it("are permitted from the master wallet with an admin key, and recorded as their own event", async () => {
      await expect(assert("withdraw", "master", "admin", EXTERNAL_ADDRESS)).resolves.toEqual({
        external: true,
      });
      expect(recorded).toEqual([{ action: "meta.withdraw.external", outcome: "success" }]);
    });

    it("apply the same rule to a redeem that forwards outside the platform", async () => {
      await expect(assert("redeem", "user", "admin", EXTERNAL_ADDRESS)).rejects.toMatchObject({
        code: "EXTERNAL_TRANSFER_FORBIDDEN",
      });
      expect(recorded).toEqual([{ action: "meta.redeem", outcome: "denied" }]);
    });
  });

  it("records every denial, so a refused withdrawal is never silent", async () => {
    await assert("withdraw", "user", "operator", EXTERNAL_ADDRESS).catch(() => undefined);
    await assert("order", "master", "admin").catch(() => undefined);
    expect(recorded.map((entry) => entry.outcome)).toEqual(["denied", "denied"]);
  });
});
