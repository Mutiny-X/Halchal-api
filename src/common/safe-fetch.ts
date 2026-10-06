import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/**
 * Outbound fetch for URLs that came from users (campaign source links,
 * creator draft links, scraped media URLs). Without this, anyone who can
 * submit a URL can make this server request its own internal network —
 * cloud metadata (169.254.169.254), localhost admin ports, *.railway.internal
 * services — and learn from the response (server-side request forgery).
 *
 * Every hop is checked: the host must resolve only to public addresses and
 * use the standard web ports, and redirects are followed by hand so a public
 * URL can't bounce the request somewhere internal.
 *
 * Residual risk: DNS is resolved here and again by fetch itself, so a hostile
 * DNS server answering differently between the two lookups ("DNS rebinding")
 * could still slip through. Closing that needs an HTTP agent with a pinned
 * lookup; this guard blocks every direct and redirect-based route.
 */

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

const MAX_REDIRECTS = 5;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const BLOCKED_HOST_SUFFIXES = [".internal", ".local", ".localhost", ".localdomain", ".lan", ".home.arpa"];

function ipv4ToInt(ip: string): number {
  return ip.split(".").reduce((acc, part) => (acc << 8) + Number(part), 0) >>> 0;
}

function inV4Range(ip: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT (also used by some cloud internals)
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata endpoints
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

/** True for any address that isn't a normal public unicast address. */
export function isNonPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    return PRIVATE_V4.some(([base, bits]) => inV4Range(address, base, bits));
  }
  if (family === 6) {
    const ip = address.toLowerCase();
    // IPv4 embedded in IPv6 (::ffff:10.0.0.1 or ::ffff:a00:1) — judge the
    // IPv4 part, since that is where the packets actually go.
    const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isNonPublicAddress(mapped[1]);
    const mappedHex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1], 16);
      const lo = parseInt(mappedHex[2], 16);
      return isNonPublicAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    if (ip === "::" || ip === "::1") return true;
    const first = parseInt(ip.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (ip.startsWith("64:ff9b:")) return true; // NAT64 — can reach IPv4 internals
    if (ip.startsWith("2001:db8:")) return true; // documentation
    return false;
  }
  return true; // not an IP at all — never treat as safe
}

type Resolver = (hostname: string) => Promise<string[]>;

const defaultResolver: Resolver = async (hostname) =>
  (await lookup(hostname, { all: true, verbatim: true })).map((a) => a.address);

let resolver: Resolver = defaultResolver;

/** Tests only: swap DNS resolution so specs don't depend on the network. */
export function setSafeFetchResolverForTests(next: Resolver | null): void {
  resolver = next ?? defaultResolver;
}

/** Throws UnsafeUrlError unless `raw` is an http(s) URL on a standard port
 * whose host resolves only to public addresses. */
export async function assertPublicHttpUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("Not a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new UnsafeUrlError("Only http and https links are supported");
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Links with embedded credentials are not supported");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new UnsafeUrlError("Only links on the standard web ports are supported");
  }

  // URL keeps IPv6 literals bracketed: [::1]
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    throw new UnsafeUrlError("That address is not reachable from here");
  }

  const addresses = isIP(host) ? [host] : await resolver(host).catch(() => []);
  if (addresses.length === 0) {
    throw new UnsafeUrlError("Could not resolve that link's host");
  }
  if (addresses.some(isNonPublicAddress)) {
    throw new UnsafeUrlError("That address is not reachable from here");
  }
  return url;
}

/** fetch() for user-supplied URLs: validates every hop (see module doc). */
export async function safeFetch(rawUrl: string, init: RequestInit = {}): Promise<Response> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const url = await assertPublicHttpUrl(current);
    const res = await fetch(url.toString(), { ...init, redirect: "manual" });
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel().catch(() => {});
      current = new URL(location, url).toString();
      continue;
    }
    return res;
  }
  throw new UnsafeUrlError("Too many redirects");
}
