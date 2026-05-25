/**
 * Connection-time DNS guard for the webhook delivery transport — the deeper SSRF
 * defense that complements the registration-time literal-host guard in
 * {@link import("./ssrf-guard.js")}.
 *
 * `ssrf-guard.ts` blocks a tenant from *registering* an endpoint whose host is a
 * literal private/internal address. It cannot, by design, catch a *hostname* that
 * resolves to a private IP — that needs DNS — nor a DNS-rebinding attack that
 * re-points a name to an internal address *after* it passed registration. This
 * module closes that residual: it builds a `lookup` function for Node's
 * `http`/`https` `request({ lookup })` option that resolves the destination
 * hostname, refuses the connection when **any** resolved address is a blocked
 * (private/internal) address, and otherwise hands Node the exact resolved set to
 * connect to. Because Node connects to the addresses this hook returns — it does
 * not resolve a second time — there is no time-of-check/time-of-use window for a
 * name to rebind between the check and the connect.
 *
 * ## Scope
 *
 * The hook fires only for *hostname* destinations: Node skips DNS for a literal-IP
 * host, so a literal private IP (`http://10.0.0.5/`) never reaches here. That case
 * is the registration guard's job — and, on the trusted local library/admin path,
 * the operator's deliberate choice. The connection-time guard is specifically the
 * "a hostname resolves to (or rebinds to) a private IP" defense.
 *
 * ## Fail-closed
 *
 * An unresolvable name, an empty result, or a result containing even one blocked
 * address rejects the whole connection. Blocking a *mixed* public+private result
 * (rather than connecting to just the public ones) defeats round-robin / very-low-
 * TTL rebinding, where an attacker cannot control which address a later connection
 * attempt would otherwise select.
 *
 * ## Opt-out
 *
 * Disabled when {@link import("./ssrf-guard.js").SsrfPolicy.allowPrivateNetworks}
 * is set — the same single opt-out that disables the registration guard. The
 * lookup then forwards every resolved address unfiltered.
 */

import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress, LookupAllOptions, LookupOptions } from "node:dns";
import type { LookupFunction } from "node:net";

import { BlockedUrlError, isBlockedHost, type SsrfPolicy } from "./ssrf-guard.js";

/**
 * Resolves a hostname to all of its addresses. The default is Node's
 * `dns.lookup` in `all` mode; tests inject a deterministic fake so the guard's
 * decision logic is exercised without touching the network or real DNS.
 */
export type AddressResolver = (
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void,
) => void;

/** The real resolver: `dns.lookup` in `{ all: true }` mode, honoring Node's hints/family. */
const defaultResolver: AddressResolver = (hostname, options, callback) => {
  const allOptions: LookupAllOptions = { ...options, all: true };
  dnsLookup(hostname, allOptions, callback);
};

/**
 * Build a {@link LookupFunction} (for `http`/`https` `request({ lookup })`) that
 * enforces `policy` at connection time: it resolves `hostname`, blocks the
 * connection if any resolved address is private/internal (unless the policy opts
 * out), and otherwise pins the connection to the resolved set. Inject `resolver`
 * to test the decision without real DNS.
 */
export function createGuardedLookup(
  policy: SsrfPolicy,
  resolver: AddressResolver = defaultResolver,
): LookupFunction {
  return (hostname, options, callback) => {
    resolver(hostname, options, (err, addresses) => {
      if (err !== null) {
        // A genuine resolution failure (NXDOMAIN, etc.) — surface it unchanged; the
        // transport turns it into a failed attempt, exactly as before.
        callback(err, "", 0);
        return;
      }
      if (addresses.length === 0) {
        callback(
          new BlockedUrlError(
            `DNS resolution for "${hostname}" returned no addresses`,
            "dns_no_address",
          ),
          "",
          0,
        );
        return;
      }
      if (!policy.allowPrivateNetworks) {
        const blocked = addresses.find((a) => isBlockedHost(a.address));
        if (blocked !== undefined) {
          callback(
            new BlockedUrlError(
              `webhook destination "${hostname}" resolves to a private or internal ` +
                `address (${blocked.address}); set POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS=true ` +
                `to allow delivery to private networks`,
              "blocked_resolved_address",
            ),
            "",
            0,
          );
          return;
        }
      }
      // Allowed. Return the resolved set in the shape Node asked for. Node's
      // http/https stack calls lookup with `{ all: true }` and expects the array;
      // the single-address branch is a defensive fallback for an `all: false` caller.
      if (options.all === true) {
        callback(null, addresses, 0);
      } else {
        callback(null, addresses[0]!.address, addresses[0]!.family);
      }
    });
  };
}
