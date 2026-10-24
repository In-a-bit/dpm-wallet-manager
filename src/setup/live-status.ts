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
  const { adminKey, walletApiKey } = store.load().secrets ?? {};
  const [wallet, platform] = await Promise.all([
    // dpm-wallet answers only {status} to a caller without its key; the vault detail needs it.
    fetchBody<WalletHealth>(http, `${urls.walletUrl}/v1/health`, walletApiKey),
    // Once setup is finished it no longer holds the admin key; the manager's own health answer
    // then stands in, with less detail.
    adminKey
      ? fetchBody<PlatformStatus>(http, `${urls.managerUrl}/v1/platform`, adminKey)
      : fetchBody<{ status?: string }>(http, `${urls.managerUrl}/v1/health`).then((health) =>
          health?.status === "ok" ? { detailUnavailable: true } : undefined,
        ),
  ]);
  const detailUnavailable = (platform as { detailUnavailable?: boolean } | undefined)
    ?.detailUnavailable;
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
        detail:
          wallet?.vault === undefined && wallet?.status === "ok"
            ? "vault status unavailable (wallet key not on hand)"
            : wallet?.vault?.ready === false
              ? "cannot reach the key provider"
              : undefined,
      },
      {
        label: "Wallet manager",
        ok: platform !== undefined,
        detail: detailUnavailable
          ? "answering (mode and wallet detail need the admin key, which setup no longer keeps)"
          : platform
            ? `${platform.mode} mode`
            : "not responding",
      },
      {
        label: "Wallets",
        ok: detailUnavailable ? true : Boolean(platform?.upstream?.reachable),
        detail: detailUnavailable
          ? "not checked"
          : platform
            ? `${platform.walletCount ?? 0} wallet(s)`
            : undefined,
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
