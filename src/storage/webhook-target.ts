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

/**
 * Decides on the 16 bytes, not the text: the URL parser rewrites `::ffff:169.254.169.254` as
 * `::ffff:a9fe:a9fe`, and several other spellings reach the same IPv4 address. An address that
 * embeds an IPv4 one (mapped, compatible, NAT64) is judged by the IPv4 rules.
 */
function forbiddenIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return true; // unparseable: refuse rather than guess
  const embedded = (): string => `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`;
  const zero = (from: number, to: number): boolean => bytes.slice(from, to).every((b) => b === 0);

  if (zero(0, 16)) return true; // ::
  if (zero(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return forbiddenIpv4(embedded());
  // (`::1` loopback also has twelve zero bytes; a leading zero octet is not a compatible address.)
  if (zero(0, 12) && bytes[12] !== 0) return forbiddenIpv4(embedded()); // IPv4-compatible ::a.b.c.d
  // 64:ff9b::/96, NAT64: the last 32 bits are the IPv4 destination.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    zero(4, 12)
  ) {
    return forbiddenIpv4(embedded());
  }
  // fe80::/10 link-local.
  if (bytes[0] === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) return true;
  // fd00:ec2::/32, the AWS IPv6 metadata range.
  return bytes[0] === 0xfd && bytes[1] === 0x00 && bytes[2] === 0x0e && bytes[3] === 0xc2;
}

/** Expands any valid textual IPv6 address (including a dotted-quad tail) to its 16 bytes. */
function ipv6Bytes(address: string): number[] | undefined {
  let text = address;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted?.[1]) {
    const parts = dotted[1].split(".").map(Number);
    if (parts.some((p) => p > 255)) return undefined;
    const hex = (hi: number, lo: number): string => ((hi << 8) | lo).toString(16);
    text = `${text.slice(0, -dotted[1].length)}${hex(parts[0]!, parts[1]!)}:${hex(parts[2]!, parts[3]!)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const bytes: number[] = [];
  for (const group of groups) {
    const value = Number.parseInt(group, 16);
    if (!/^[0-9a-f]{1,4}$/i.test(group) || Number.isNaN(value)) return undefined;
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
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
