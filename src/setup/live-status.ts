import type { SetupStateStore } from "./state";
import type { SetupHttp } from "./steps";

export type HealthCheck = { label: string; ok: boolean; detail?: string };

type WalletHealth = { status?: string; vault?: { initialized?: boolean; ready?: boolean } };
type PlatformStatus = {
  mode?: string;
  walletCount?: number;
  upstream?: { reachable?: boolean; vault?: { initialized?: boolean; ready?: boolean } };
};

/**
 * What the status page shows: each service, in words. Never throws, since a status page that
 * errors when something is down is useless exactly when it is needed.
 */
export async function liveStatus(
  http: SetupHttp,
  store: SetupStateStore,
  urls: { walletUrl: string; managerUrl: string },
): Promise<{ checks: HealthCheck[] }> {
  const adminKey = store.load().secrets?.adminKey;
  const [wallet, platform] = await Promise.all([
    fetchBody<WalletHealth>(http, `${urls.walletUrl}/v1/health`),
    fetchBody<PlatformStatus>(http, `${urls.managerUrl}/v1/platform`, adminKey),
  ]);
  return {
    checks: [
      {
        label: "Wallet service",
        ok: wallet?.status === "ok",
        detail: wallet ? undefined : "not responding",
      },
      {
        label: "Key vault",
        ok: Boolean(wallet?.vault?.initialized && wallet.vault.ready),
        detail: wallet?.vault?.ready === false ? "cannot reach the key provider" : undefined,
      },
      {
        label: "Wallet manager",
        ok: platform !== undefined,
        detail: platform ? `${platform.mode} mode` : "not responding",
      },
      {
        label: "Wallets",
        ok: Boolean(platform?.upstream?.reachable),
        detail: platform ? `${platform.walletCount ?? 0} wallet(s)` : undefined,
      },
    ],
  };
}

async function fetchBody<T>(http: SetupHttp, url: string, apiKey?: string): Promise<T | undefined> {
  try {
    const result = await http("GET", url, { apiKey });
    return result.status === 200 ? (result.body as T) : undefined;
  } catch {
    return undefined;
  }
}
