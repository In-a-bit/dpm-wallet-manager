import { FAKE_UPSTREAM_API_KEY, FakeDpmWallet } from "../testing/fake-dpm-wallet";
import { fetchHttp } from "./http";
import { liveStatus } from "./live-status";
import type { SetupStateStore } from "./state";

/**
 * dpm-wallet answers `GET /v1/health` with the status alone to a caller without its key, and adds
 * the vault detail only for one that presents it. The fake wallet follows the same rule, so these
 * fail if the status page stops sending the key.
 */
describe("liveStatus", () => {
  const wallet = new FakeDpmWallet();
  let walletUrl: string;

  beforeAll(async () => {
    walletUrl = await wallet.start();
  });

  afterAll(async () => {
    await wallet.stop();
  });

  beforeEach(() => wallet.reset());

  const storeWith = (walletApiKey: string | undefined): SetupStateStore =>
    ({
      load: () => ({ secrets: walletApiKey === undefined ? undefined : { walletApiKey } }),
    }) as unknown as SetupStateStore;

  const urls = () => ({ walletUrl, managerUrl: "http://127.0.0.1:1" });
  const vaultCheck = async (store: SetupStateStore) =>
    (await liveStatus(fetchHttp, store, urls())).checks.find((c) => c.label === "Key vault");

  it("reads the vault detail by presenting the wallet key", async () => {
    const check = await vaultCheck(storeWith(FAKE_UPSTREAM_API_KEY));

    expect(check?.ok).toBe(true);
    expect(wallet.requests.find((r) => r.path === "/v1/health")?.headers["x-api-key"]).toBe(
      FAKE_UPSTREAM_API_KEY,
    );
  });

  it("reports the vault as unavailable, not healthy, when the key is not on hand", async () => {
    const check = await vaultCheck(storeWith(undefined));

    expect(check?.ok).toBe(false);
    expect(check?.detail).toMatch(/unavailable/);
  });
});
