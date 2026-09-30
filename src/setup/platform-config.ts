import { toContainerUrl } from "./environments";

/** Header dpm-api authenticates a custody builder's own backend by. */
export const BUILDER_KEY_HEADER = "X-Builder-Api-Private-Key";

const REQUEST_TIMEOUT_MS = 15_000;

/** The body of dpm-api `GET /wallet-install/config`. */
export type InstallConfig = {
  owner: { type: string; id: number; name: string; builder_type?: string };
  chain_id: number;
  app_api_key: string;
  contracts: { ctf_exchange: string; proxy_factory: string; proxy_impl: string };
  services: { dpm_api: string; gamma_api: string; relayer_api: string };
};

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** A failure worded for the person at the setup page, not for a log. */
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

async function requestInstallConfig(
  dpmApiUrl: string,
  key: string,
  fetchImpl: FetchLike,
): Promise<Response> {
  const url = `${toContainerUrl(dpmApiUrl)}/wallet-install/config`;
  try {
    return await fetchImpl(url, {
      headers: { [BUILDER_KEY_HEADER]: key },
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
 * the setup page. Only a JSON `message` (or `error`) is worth showing, and only briefly.
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
  return {
    ...config,
    services: {
      dpm_api: toContainerUrl(config.services.dpm_api),
      gamma_api: toContainerUrl(config.services.gamma_api),
      relayer_api: toContainerUrl(config.services.relayer_api),
    },
  };
}
