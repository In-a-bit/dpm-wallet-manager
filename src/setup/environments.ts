/**
 * The platforms an install can join. Each is named by the public dpm-api URL a setup asks for
 * the rest of its configuration (see platform-config.ts); everything else — the other services'
 * URLs, the chain, the contracts — comes back from there, so this is the only list to maintain.
 */
export type EnvironmentId = "prod" | "dev" | "custom";

/** The environment the page starts with selected. */
export const DEFAULT_ENVIRONMENT: EnvironmentId = "prod";

export type Environment = {
  id: EnvironmentId;
  label: string;
  description: string;
  /** Undefined only for "custom", whose URL the user types (a local platform is one of these). */
  dpmApiUrl?: string;
  /** The `<env>` label inside the install's API keys (`dpmm_<env>_…`). */
  keyEnv: string;
  /** Shown only behind the "advanced" toggle. */
  advanced: boolean;
};

export const ENVIRONMENTS: readonly Environment[] = [
  {
    id: "prod",
    label: "Production",
    description: "Real markets and real funds.",
    dpmApiUrl: "https://api.dpm.network",
    keyEnv: "live",
    advanced: false,
  },
  {
    id: "dev",
    label: "Development",
    description: "The platform team's development environment.",
    dpmApiUrl: "https://dpm-api.inabit.dev",
    keyEnv: "dev",
    advanced: true,
  },
  {
    id: "custom",
    label: "Custom",
    description:
      "Another platform, by its address. For one running on this computer, use http://localhost:8086.",
    keyEnv: "custom",
    advanced: true,
  },
];

export function findEnvironment(id: string): Environment | undefined {
  return ENVIRONMENTS.find((env) => env.id === id);
}

/**
 * The dpm-api URL to ask, or an error message a person can act on. A custom URL must be a plain
 * http(s) address; anything else would only fail later with a less helpful error.
 */
export function resolveDpmApiUrl(env: Environment, customUrl?: string): string | { error: string } {
  if (env.dpmApiUrl) return env.dpmApiUrl;
  const trimmed = (customUrl ?? "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) {
    return { error: "Enter the platform address, starting with https://" };
  }
  if (!isSafePlatformUrl(trimmed)) {
    return {
      error:
        "A platform address must use https://. Plain http:// is accepted only for a platform on " +
        "this computer (localhost or host.docker.internal), because the builder key travels to it.",
    };
  }
  return trimmed;
}

/**
 * Whether a platform address may be used. The builder key is sent to it, so plain `http://` is
 * allowed only where the traffic never leaves this computer.
 */
export function isSafePlatformUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && PLAIN_HTTP_HOSTS.has(parsed.hostname);
}

/** The answers that name a platform by its address: a listed one by its id, any other as custom. */
export function environmentForUrl(url: string): { environment: EnvironmentId; customUrl?: string } {
  const trimmed = url.trim().replace(/\/+$/, "");
  const listed = ENVIRONMENTS.find((env) => env.dpmApiUrl === trimmed);
  return listed ? { environment: listed.id } : { environment: "custom", customUrl: trimmed };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DOCKER_HOST = "host.docker.internal";
const PLAIN_HTTP_HOSTS = new Set([...LOOPBACK_HOSTS, DOCKER_HOST]);

/**
 * A platform running on this computer reports its services at `localhost`, which inside a
 * container is the container itself. The services are reached through the Docker host instead.
 */
export function toContainerUrl(url: string): string {
  const parsed = new URL(url);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return url.replace(/\/+$/, "");
  parsed.hostname = DOCKER_HOST;
  return parsed.toString().replace(/\/+$/, "");
}
