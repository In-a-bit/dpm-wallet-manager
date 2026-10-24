import { isSafePlatformUrl, toContainerUrl } from "./environments";

/** Header dpm-api authenticates a custody builder's own backend by. */
export const BUILDER_KEY_HEADER = "X-Builder-Api-Private-Key";

const REQUEST_TIMEOUT_MS = 15_000;

/** The body of dpm-api `GET /wallet-install/config`. */
export type InstallConfig = {
  owner: { type: string; id: number; name: string; builder_type?: string };
  chain_id: number;
  contracts: { ctf_exchange: string; proxy_factory: string; proxy_impl: string };
  /** `data_api` is optional: a platform that does not offer one still installs. */
  services: { dpm_api: string; gamma_api: string; relayer_api: string; data_api?: string };
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A failure worded for the person running setup, not for a log. */
export class SetupError extends Error {}

/**
 * Asks the platform for everything the install needs, using the builder key the install will run
 * with. A key that passes here is known to work before anything is created, which is the point:
 * a wrong key is caught while it is still cheap to fix.
 */
export async function fetchInstallConfig(
  dpmApiUrl: string,
  builderKey: string,
  fetchImpl: FetchLike = fetch,
): Promise<InstallConfig> {
  const key = builderKey.trim();
  if (!key) throw new SetupError("Paste the builder private key from the backoffice.");
  const response = await requestInstallConfig(dpmApiUrl, key, fetchImpl);
  if (!response.ok) throw new SetupError(await messageForStatus(response));
  return withContainerUrls((await response.json()) as InstallConfig);
}

/**
 * Checks an address before any key is asked for: the endpoint must answer, and refuse a request
 * without a key. That tells a wrong address apart from a wrong key, which are fixed differently.
 */
export async function probePlatform(
  dpmApiUrl: string,
  fetchImpl: FetchLike = fetch,
): Promise<void> {
  const response = await requestInstallConfig(dpmApiUrl, undefined, fetchImpl);
  if (response.status === 401) return;
  if (response.status === 404) {
    throw new SetupError(
      `The platform at ${dpmApiUrl} does not support self-install yet (it has no /wallet-install/config). Check the address, or ask the platform team.`,
    );
  }
  throw new SetupError(await unexpectedStatusMessage(response));
}

async function requestInstallConfig(
  dpmApiUrl: string,
  key: string | undefined,
  fetchImpl: FetchLike,
): Promise<Response> {
  const url = `${toContainerUrl(dpmApiUrl)}/wallet-install/config`;
  try {
    return await fetchImpl(url, {
      headers: key ? { [BUILDER_KEY_HEADER]: key } : {},
      // The key is in that header: a redirect (https -> http, or to another host) would re-send it.
      redirect: "error",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new SetupError(
      `Could not reach the platform at ${dpmApiUrl}. Check this computer's internet connection (or, for a platform on this computer, that it is running) and try again.`,
    );
  }
}

async function messageForStatus(response: Response): Promise<string> {
  switch (response.status) {
    case 401:
      return "This key was not accepted. Copy the whole key from the backoffice again (it starts with bld_sk_), and check you chose the right environment.";
    case 409:
      return "This key belongs to an embedded builder, which does not use a DPM Wallet. Ask for a custody builder key.";
    case 503:
      return "This environment is not ready for self-install yet. Please contact the platform team.";
    default:
      return unexpectedStatusMessage(response);
  }
}

const MAX_DETAIL_CHARS = 200;

/**
 * A gateway in front of the platform answers failures with a whole HTML page, which is no use on
 * a person running setup. Only a JSON `message` (or `error`) is worth showing, and only briefly.
 */
async function unexpectedStatusMessage(response: Response): Promise<string> {
  if (response.status >= 500) {
    return `The platform is temporarily unavailable (${response.status}). Try again in a few minutes.`;
  }
  const detail = await jsonDetail(response);
  const suffix = detail ? `: ${detail.slice(0, MAX_DETAIL_CHARS)}` : ".";
  return `The platform refused the request (${response.status})${suffix}`;
}

async function jsonDetail(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { message?: unknown; error?: unknown };
    const detail = body.message ?? body.error;
    return typeof detail === "string" ? detail : undefined;
  } catch {
    return undefined;
  }
}

/** Every service URL the install is handed must be reachable from inside its containers. */
function withContainerUrls(config: InstallConfig): InstallConfig {
  const { data_api: dataApi, ...services } = config.services;
  // The platform names these addresses itself; one on plain http:// away from this computer would
  // carry the builder key in the clear, so it is refused rather than installed.
  for (const [name, url] of Object.entries(config.services)) {
    if (typeof url !== "string" || !isSafePlatformUrl(url)) {
      throw new SetupError(
        `The platform gave an unsafe address for its ${name.replace(/_/g, "-")} service. Services must use https:// (http:// only for a platform on this computer). Ask the platform team to fix its PUBLIC_*_URL settings.`,
      );
    }
  }
  return {
    ...config,
    services: {
      dpm_api: toContainerUrl(services.dpm_api),
      gamma_api: toContainerUrl(services.gamma_api),
      relayer_api: toContainerUrl(services.relayer_api),
      ...(dataApi ? { data_api: toContainerUrl(dataApi) } : {}),
    },
  };
}
