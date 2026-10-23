import type { DpmWalletClient } from "../clients/dpm-wallet.client";
import type { Actor } from "../common/actor";
import type { OperationRepository } from "../db/repositories/operation.repo";
import type { WalletsService } from "../wallets/wallets.service";
import type { MetaTxService } from "./meta-tx.service";
import { TransfersService } from "./transfers.service";

const ACTOR = { keyId: "key-1" } as unknown as Actor;
const ARGS = { amountDecimal: "1.5", recipient: "0x0000000000000000000000000000000000000009" };

/**
 * Stands in for dpm-wallet: signing and relaying are both replayed by key, as its global
 * idempotency interceptor does, and only a success is stored.
 */
function harness() {
  const signBodies: unknown[] = [];
  const relayBodies: unknown[] = [];
  const relayKeys: Array<string | undefined> = [];
  const signedByKey = new Map<string, Record<string, unknown>>();
  const relayedByKey = new Map<string, Record<string, unknown>>();
  let nonce = 100;
  let relayCount = 0;

  const metaTx = {
    build: jest.fn(
      async (_kind: string, walletId: string, args: unknown, _a: Actor, key?: string) => {
        signBodies.push({ walletId, args, key });
        const signingKey = key ? `${key}:withdraw` : undefined;
        let signed = signingKey ? signedByKey.get(signingKey) : undefined;
        if (!signed) {
          nonce += 1;
          signed = {
            from: "0xfrom",
            to: "0xto",
            data: "0xdata",
            nonce: String(nonce),
            signature: `0xsig${nonce}`,
          };
          if (signingKey) signedByKey.set(signingKey, signed);
        }
        return { ...signed, walletId, operationId: `op-${String(signed.nonce)}`, external: false };
      },
    ),
  };
  const upstream = {
    relay: jest.fn(async (body: unknown, options?: { idempotencyKey?: string }) => {
      relayBodies.push(JSON.stringify(body));
      relayKeys.push(options?.idempotencyKey);
      const key = options?.idempotencyKey;
      const replay = key ? relayedByKey.get(key) : undefined;
      if (replay) return replay;
      relayCount += 1;
      const response = { transactionID: `tx-${relayCount}`, state: "STATE_NEW" };
      if (key) relayedByKey.set(key, response);
      return response;
    }),
  };
  const operations = { setRelayerTransactionId: jest.fn(async () => undefined) };
  const service = new TransfersService(
    metaTx as unknown as MetaTxService,
    {} as WalletsService,
    upstream as unknown as DpmWalletClient,
    operations as unknown as OperationRepository,
  );
  return { service, upstream, operations, relayBodies, relayKeys };
}

describe("TransfersService.transfer", () => {
  it("replays the relay on a retry after a crash between relaying and recording", async () => {
    const { service, operations, relayBodies, relayKeys } = harness();
    operations.setRelayerTransactionId.mockRejectedValueOnce(new Error("crash"));

    await expect(service.transfer("w1", ARGS, ACTOR, "k1")).rejects.toThrow("crash");
    const second = await service.transfer("w1", ARGS, ACTOR, "k1");

    expect(relayBodies).toHaveLength(2);
    expect(relayBodies[1]).toBe(relayBodies[0]);
    expect(relayKeys).toEqual(["k1:relay", "k1:relay"]);
    expect(second.relayerTransactionId).toBe("tx-1");
    expect(operations.setRelayerTransactionId).toHaveBeenLastCalledWith("op-101", "tx-1");
  });

  it("sends no relay key when the caller gave none", async () => {
    const { service, relayKeys } = harness();
    await service.transfer("w1", ARGS, ACTOR);
    expect(relayKeys).toEqual([undefined]);
  });
});
