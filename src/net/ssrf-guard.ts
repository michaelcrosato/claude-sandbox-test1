/**
 * SSRF guard for tenant-supplied webhook destination URLs.
 *
 * Posthorn is a webhook *sender*: it POSTs signed payloads to URLs that its
 * tenants register. A tenant-controlled destination is therefore an untrusted
 * input, and a tenant who registers an internal address —
 * `http://localhost:6379/`, `http://169.254.169.254/…` (cloud instance
 * metadata), `http://10.0.0.5/admin`, `http://redis:6379/` — could coerce the
 * gateway into issuing requests against the operator's own private network: a
 * textbook Server-Side Request Forgery vector. Every serious webhook platform
 * (Svix, Hookdeck, Convoy, …) refuses delivery to private/internal address
 * space; this module is Posthorn's implementation.
 *
 * The guard is **pure** and classifies a URL by its host:
 *  - a literal IP (v4 or v6, including an IPv4-mapped v6 like `::ffff:127.0.0.1`)
 *    is checked against the blocked ranges (loopback, private, link-local incl.
 *    the metadata address, CGNAT, unspecified, unique-local, multicast, …);
 *  - a hostname is blocked when it is a known-internal name (`localhost`, a
 *    `.localhost`/`.local`/`.internal` suffix) or a bare single-label name
 *    (`http://redis/` — never a valid *public* destination, but a real
 *    container/k8s internal target). A *public* hostname that resolves to a
 *    private IP cannot be caught without DNS — see "Limitations".
 *
 * ## Where it is enforced
 *
 * At the untrusted boundary only: endpoint **create/update** over the JSON API
 * (`POST/PATCH /v1/endpoints`) and the always-on consumer portal. A stored URL
 * is thus validated when it is *set*; delivery and the test-send operate on
 * already-validated data and do not re-check, so an operator who deliberately
 * registers an internal URL through the trusted local `posthorn admin`/library
 * path is never second-guessed at delivery time (a coherent "validate at
 * registration" model — no surprising, hard-to-diagnose delivery breakage on a
 * policy change or upgrade).
 *
 * ## Opt-out
 *
 * Blocking is the **default** (secure by default). A self-hoster who genuinely
 * delivers to trusted internal services flips
 * `POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true`
 * ({@link import("../runtime/config.js").GatewayConfig.allowPrivateNetworks}),
 * which disables the guard entirely.
 *
 * ## Limitations
 *
 * This is a registration-time, literal-host guard. It does not resolve DNS, so a
 * public hostname that resolves to a private IP (or a DNS-rebinding attack that
 * re-points a name *after* registration) is not caught here; a connection-time
 * resolved-IP check is the deeper defense and a noted follow-up. Literal IPv6
 * embedded-IPv4 forms, however, *are* fully decoded regardless of spelling — the
 * hex form `::ffff:7f00:1` is classified identically to the dotted
 * `::ffff:127.0.0.1`.
 */

import { isIP } from "node:net";

/**
 * The delivery policy: when {@link SsrfPolicy.allowPrivateNetworks} is `true` the
 * guard is disabled and any syntactically-valid `http(s)` URL is permitted.
 */
export interface SsrfPolicy {
  /** Allow webhook delivery to private/internal addresses (disables the guard). */
  readonly allowPrivateNetworks: boolean;
}

/**
 * A webhook destination URL was rejected because its host is a private or
 * internal address and the policy blocks such targets. Carries a machine-readable
 * {@link BlockedUrlError.reason}. The HTTP API maps it to `400 url_not_allowed`;
 * the portal surfaces its message inline.
 */
export class BlockedUrlError extends Error {
  /** Machine-readable cause (e.g. `"blocked_host"`). */
  readonly reason: string;
  constructor(message: string, reason: string) {
    super(message);
    this.name = "BlockedUrlError";
    this.reason = reason;
  }
}

/** Split a dotted-quad into its four octets, or `null` if it is not one. */
function ipv4Octets(ip: string): [number, number, number, number] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

/**
 * Classify a literal IPv4 address as private/internal. Blocks loopback (127/8),
 * the RFC 1918 private ranges (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16 — which includes the 169.254.169.254 cloud-metadata address),
 * CGNAT (100.64/10), "this host" (0/8), IETF protocol assignments (192.0.0/24),
 * benchmarking (198.18/15), and everything from 224.0.0.0 up (multicast 224/4,
 * reserved 240/4, and the 255.255.255.255 broadcast).
 */
export function isBlockedIpv4(ip: string): boolean {
  const o = ipv4Octets(ip);
  if (o === null) return true; // isIP said v4 but we can't parse it — fail closed
  const [a, b, c] = o;
  if (a === 0) return true; // 0.0.0.0/8 — "this host"
  if (a === 10) return true; // 10.0.0.0/8 — private
  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local (metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 — IETF
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 — benchmark
  if (a >= 224) return true; // 224/4 multicast + 240/4 reserved + 255.255.255.255 broadcast
  return false;
}

/**
 * Expand an IPv6 literal into its eight 16-bit hextets (each `0`–`0xffff`), or
 * `null` if the string is not a parseable IPv6 address. Resolves `::`
 * zero-compression and converts a trailing embedded IPv4 written in dotted form
 * (`::ffff:127.0.0.1` → the final two hextets become `0x7f00`, `0x0001`) so the
 * whole address is uniform hex. The input must already be lowercased with any
 * zone id stripped. Expanding (rather than string-prefix matching) lets the
 * classifier judge an address by its actual bits, independent of textual form.
 */
function expandIpv6(addr: string): number[] | null {
  let s = addr;
  // Fold a trailing dotted-quad (IPv4-mapped/compatible written canonically) into
  // two hextets so the address is pure hex before the "::" split below.
  const dotted = s.match(/^(.*:)(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted !== null) {
    const o = ipv4Octets(dotted[2]!);
    if (o === null) return null;
    const hex = `${((o[0]! << 8) | o[1]!).toString(16)}:${((o[2]! << 8) | o[3]!).toString(16)}`;
    s = dotted[1]! + hex;
  }
  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::" run is legal
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    for (const g of part.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  if (head === null) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null; // no "::" → must be exactly 8 groups
  }
  const tail = parseGroups(halves[1]!);
  if (tail === null) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 1) return null; // "::" must stand for at least one zero group
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

/**
 * Classify a literal IPv6 address as private/internal. Blocks loopback (`::1`),
 * the unspecified address (`::`), link-local (`fe80::/10`), unique-local
 * (`fc00::/7`), and multicast (`ff00::/8`). Any address carrying an embedded IPv4
 * — IPv4-mapped (`::ffff:0:0/96`), the deprecated IPv4-compatible block (`::/96`),
 * or the NAT64 well-known prefix (`64:ff9b::/96`) — is unwrapped and judged by its
 * embedded v4 via {@link isBlockedIpv4}, in **every** textual spelling: the dotted
 * form (`::ffff:127.0.0.1`) *and* the all-hex form (`::ffff:7f00:1`,
 * `0:0:0:0:0:ffff:7f00:1`) both resolve to `127.0.0.1` and are blocked, closing
 * the bypass where only the dotted form was caught. The address is expanded to its
 * 128 bits first, so classification is independent of how `::`/leading zeros are
 * written. An unparseable literal fails closed (blocked).
 */
export function isBlockedIpv6(ip: string): boolean {
  const addr = ip.toLowerCase().split("%")[0]!; // drop any zone id (fe80::1%eth0)
  const h = expandIpv6(addr);
  if (h === null) return true; // isIP accepted it but we can't expand — fail closed

  // Embedded-IPv4 forms route to the v4 classifier so the hex spelling of a mapped
  // address is caught exactly like its dotted form. `top5Zero` (the address sits in
  // ::/80) covers both IPv4-mapped (h[5] === 0xffff) and the IPv4-compatible block
  // (h[5] === 0, which also subsumes `::` → 0.0.0.0 and `::1` → 0.0.0.1, both blocked
  // by isBlockedIpv4); NAT64 is the distinct 64:ff9b::/96 prefix.
  const top5Zero =
    h[0]! === 0 && h[1]! === 0 && h[2]! === 0 && h[3]! === 0 && h[4]! === 0;
  const isMapped = top5Zero && h[5]! === 0xffff;
  const isCompatible = top5Zero && h[5]! === 0;
  const isNat64 =
    h[0]! === 0x0064 && h[1]! === 0xff9b && h[2]! === 0 && h[3]! === 0 &&
    h[4]! === 0 && h[5]! === 0;
  if (isMapped || isCompatible || isNat64) {
    const v4 = `${h[6]! >> 8}.${h[6]! & 0xff}.${h[7]! >> 8}.${h[7]! & 0xff}`;
    return isBlockedIpv4(v4);
  }

  if ((h[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
  if ((h[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 — unique-local
  if ((h[0]! & 0xff00) === 0xff00) return true; // ff00::/8 — multicast
  return false;
}

/**
 * Classify a non-IP hostname as internal. Blocks `localhost`, any
 * `.localhost`/`.local`/`.internal` suffix, and any bare single-label name (no
 * dot) — a single-label host is never a valid public webhook destination but is
 * a real container/k8s internal target (`http://redis/`).
 */
export function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, ""); // strip the FQDN root dot
  if (h.length === 0) return true;
  if (!h.includes(".")) return true; // single-label (localhost, redis, db, …)
  if (h.endsWith(".localhost")) return true;
  if (h.endsWith(".local")) return true; // mDNS
  if (h.endsWith(".internal")) return true; // e.g. metadata.google.internal
  return false;
}

/**
 * Classify any host string (literal IPv4/IPv6 or hostname) as private/internal.
 * The single source of truth shared by {@link isUrlDeliverable} and
 * {@link assertUrlDeliverable}.
 */
export function isBlockedHost(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return isBlockedIpv4(host);
  if (family === 6) return isBlockedIpv6(host);
  return isBlockedHostname(host);
}

/** Extract the bare hostname from a URL, stripping IPv6 brackets; `null` if unparseable. */
function hostnameOf(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname;
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

/**
 * Non-throwing predicate: `true` if `url` may be delivered to under `policy`.
 * An unparseable URL returns `true` here — URL *syntax* is the endpoint store's
 * responsibility ({@link import("../endpoints/endpoint.js")} rejects it); this
 * guard only judges *where* a well-formed URL points.
 */
export function isUrlDeliverable(url: string, policy: SsrfPolicy): boolean {
  if (policy.allowPrivateNetworks) return true;
  const host = hostnameOf(url);
  if (host === null) return true;
  return !isBlockedHost(host);
}

/**
 * Throw {@link BlockedUrlError} if `url` targets a private/internal address under
 * `policy`. A no-op when {@link SsrfPolicy.allowPrivateNetworks} is set or when
 * the URL cannot be parsed (deferred to the store's syntactic validation).
 */
export function assertUrlDeliverable(url: string, policy: SsrfPolicy): void {
  if (policy.allowPrivateNetworks) return;
  const host = hostnameOf(url);
  if (host === null) return;
  if (isBlockedHost(host)) {
    throw new BlockedUrlError(
      `webhook destination host "${host}" is a private or internal address; ` +
        `set POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true to allow delivery to private networks`,
      "blocked_host",
    );
  }
}
