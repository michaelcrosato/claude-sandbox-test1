import { describe, expect, it } from "vitest";
import type { LookupAddress } from "node:dns";
import type { LookupOptions } from "node:dns";

import { BlockedUrlError, type SsrfPolicy } from "./ssrf-guard.js";
import { createGuardedLookup, type AddressResolver } from "./guarded-lookup.js";

const BLOCK: SsrfPolicy = { allowPrivateNetworks: false };
const ALLOW: SsrfPolicy = { allowPrivateNetworks: true };

/** A deterministic resolver that always returns `addresses` — no real DNS. */
function fakeResolver(addresses: LookupAddress[]): AddressResolver {
  return (_hostname, _options, callback) => {
    callback(null, addresses);
  };
}

/** A resolver that fails like a genuine NXDOMAIN. */
function failingResolver(err: NodeJS.ErrnoException): AddressResolver {
  return (_hostname, _options, callback) => {
    callback(err, []);
  };
}

const v4 = (address: string): LookupAddress => ({ address, family: 4 });
const v6 = (address: string): LookupAddress => ({ address, family: 6 });

/** Drive a guarded lookup once and capture its callback arguments. */
function run(
  lookup: ReturnType<typeof createGuardedLookup>,
  hostname: string,
  options: LookupOptions = { all: true },
): Promise<{
  err: NodeJS.ErrnoException | null;
  address: string | LookupAddress[];
  family: number | undefined;
}> {
  return new Promise((resolve) => {
    lookup(hostname, options, (err, address, family) => {
      resolve({ err, address, family });
    });
  });
}

describe("createGuardedLookup — blocking policy", () => {
  it("forwards the full resolved set when every address is public", async () => {
    const addrs = [v4("93.184.216.34"), v6("2606:2800:220:1:248:1893:25c8:1946")];
    const lookup = createGuardedLookup(BLOCK, fakeResolver(addrs));
    const { err, address } = await run(lookup, "example.com");
    expect(err).toBeNull();
    expect(address).toEqual(addrs);
  });

  it.each([
    ["loopback", "127.0.0.1"],
    ["rfc1918", "10.0.0.5"],
    ["rfc1918 192.168", "192.168.1.10"],
    ["link-local metadata", "169.254.169.254"],
    ["cgnat", "100.64.0.1"],
  ])("blocks a hostname resolving to a private IPv4 (%s)", async (_label, ip) => {
    const lookup = createGuardedLookup(BLOCK, fakeResolver([v4(ip)]));
    const { err } = await run(lookup, "attacker.example");
    expect(err).toBeInstanceOf(BlockedUrlError);
    expect((err as BlockedUrlError).reason).toBe("blocked_resolved_address");
    expect(err?.message).toContain(ip);
  });

  it.each([
    ["loopback", "::1"],
    ["unique-local", "fd00::1"],
    ["link-local", "fe80::1"],
    ["hex-mapped loopback", "::ffff:7f00:1"],
  ])("blocks a hostname resolving to a private IPv6 (%s)", async (_label, ip) => {
    const lookup = createGuardedLookup(BLOCK, fakeResolver([v6(ip)]));
    const { err } = await run(lookup, "attacker.example");
    expect(err).toBeInstanceOf(BlockedUrlError);
    expect((err as BlockedUrlError).reason).toBe("blocked_resolved_address");
  });

  it("fails closed on a mixed public+private result (round-robin rebinding)", async () => {
    const lookup = createGuardedLookup(
      BLOCK,
      fakeResolver([v4("93.184.216.34"), v4("169.254.169.254")]),
    );
    const { err } = await run(lookup, "rebind.example");
    expect(err).toBeInstanceOf(BlockedUrlError);
    expect(err?.message).toContain("169.254.169.254");
  });

  it("fails closed when resolution returns no addresses", async () => {
    const lookup = createGuardedLookup(BLOCK, fakeResolver([]));
    const { err } = await run(lookup, "empty.example");
    expect(err).toBeInstanceOf(BlockedUrlError);
    expect((err as BlockedUrlError).reason).toBe("dns_no_address");
  });

  it("propagates a genuine resolution error unchanged", async () => {
    const nxdomain: NodeJS.ErrnoException = Object.assign(new Error("getaddrinfo ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    const lookup = createGuardedLookup(BLOCK, failingResolver(nxdomain));
    const { err } = await run(lookup, "does-not-exist.example");
    expect(err).toBe(nxdomain);
    expect(err).not.toBeInstanceOf(BlockedUrlError);
  });

  it("returns a single (address, family) pair when called with all:false", async () => {
    const lookup = createGuardedLookup(BLOCK, fakeResolver([v4("93.184.216.34")]));
    const { err, address, family } = await run(lookup, "example.com", { all: false });
    expect(err).toBeNull();
    expect(address).toBe("93.184.216.34");
    expect(family).toBe(4);
  });
});

describe("createGuardedLookup — allowPrivateNetworks opt-out", () => {
  it("forwards private addresses unfiltered when the guard is disabled", async () => {
    const addrs = [v4("127.0.0.1"), v4("10.0.0.5")];
    const lookup = createGuardedLookup(ALLOW, fakeResolver(addrs));
    const { err, address } = await run(lookup, "internal.svc");
    expect(err).toBeNull();
    expect(address).toEqual(addrs);
  });

  it("still surfaces a genuine resolution error when disabled", async () => {
    const nxdomain: NodeJS.ErrnoException = Object.assign(new Error("ENOTFOUND"), {
      code: "ENOTFOUND",
    });
    const lookup = createGuardedLookup(ALLOW, failingResolver(nxdomain));
    const { err } = await run(lookup, "does-not-exist.example");
    expect(err).toBe(nxdomain);
  });
});
