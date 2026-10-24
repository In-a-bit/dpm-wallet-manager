import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Where an alert webhook may not point. The webhook URL is typed into the admin UI and POSTed to
 * from inside the install's network, so an address that serves cloud instance credentials
 * (169.254.169.254, the IPv6 metadata endpoint fd00:ec2::254) or any other link-local address is
 * refused: the request would reach a service meant for the host, not for a receiver. Loopback and
 * private ranges stay allowed, since a receiver on the same network is a legitimate target.
 */
export function isForbiddenWebhookAddress(address: string): boolean {
  const host = address.toLowerCase().replace(/^\[|\]$/g, "");
  const version = isIP(host);
  if (version === 4) return forbiddenIpv4(host);
  if (version === 6) return forbiddenIpv6(host);
  return host === "metadata.google.internal" || host === "metadata";
}

function forbiddenIpv4(address: string): boolean {
  const [a, b] = address.split(".").map(Number);
  // 169.254.0.0/16 link-local (cloud metadata), and 0.0.0.0/8 "this host".
  return a === 169 && b === 254 ? true : a === 0;
}

function forbiddenIpv6(address: string): boolean {
  // Expand enough to compare the leading groups; `::ffff:a.b.c.d` carries an IPv4 address.
  const mapped = /^(?:::ffff:|0:0:0:0:0:ffff:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped?.[1]) return forbiddenIpv4(mapped[1]);
  if (address === "::") return true;
  const first = address.split(":")[0] ?? "";
  const high = Number.parseInt(first || "0", 16);
  // fe80::/10 link-local.
  if (high >= 0xfe80 && high <= 0xfebf) return true;
  // fd00:ec2::/32, the AWS IPv6 metadata range.
  return /^fd00:0*ec2:/.test(address) || address === "fd00:ec2::";
}

export class WebhookTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebhookTargetError";
  }
}

/**
 * Refuses a URL whose host is, or resolves to, a forbidden address. Resolving here narrows the
 * name-points-at-metadata case but cannot close a DNS answer that changes between this check and
 * the request; the redirect refusal and the literal-address check cover the rest.
 */
export async function assertWebhookTarget(
  url: string,
  resolve: (host: string) => Promise<string[]> = resolveAll,
): Promise<void> {
  const { hostname } = new URL(url);
  if (isForbiddenWebhookAddress(hostname))
    throw new WebhookTargetError("webhook target is a forbidden address");
  if (isIP(hostname.replace(/^\[|\]$/g, "")) !== 0) return;
  const addresses = await resolve(hostname);
  if (addresses.some(isForbiddenWebhookAddress)) {
    throw new WebhookTargetError("webhook target resolves to a forbidden address");
  }
}

async function resolveAll(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((entry) => entry.address);
}
