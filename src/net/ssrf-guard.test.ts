import { describe, expect, it } from "vitest";
import {
  BlockedUrlError,
  assertUrlDeliverable,
  isBlockedHost,
  isBlockedHostname,
  isBlockedIpv4,
  isBlockedIpv6,
  isUrlDeliverable,
  type SsrfPolicy,
} from "./ssrf-guard.js";

const BLOCK: SsrfPolicy = { allowPrivateNetworks: false };
const ALLOW: SsrfPolicy = { allowPrivateNetworks: true };

describe("isBlockedIpv4", () => {
  it.each([
    "0.0.0.0",
    "0.1.2.3",
    "10.0.0.1",
    "10.255.255.255",
    "127.0.0.1",
    "127.1.2.3",
    "169.254.169.254", // cloud instance metadata — the canonical SSRF target
    "169.254.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.0.1",
    "192.168.1.100",
    "100.64.0.1", // CGNAT
    "100.127.255.255",
    "192.0.0.1", // IETF protocol assignments
    "198.18.0.1", // benchmarking
    "198.19.255.255",
    "224.0.0.1", // multicast
    "239.255.255.255",
    "240.0.0.1", // reserved
    "255.255.255.255", // broadcast
  ])("blocks private/internal %s", (ip) => {
    expect(isBlockedIpv4(ip)).toBe(true);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "172.15.255.255", // just below the 172.16/12 private block
    "172.32.0.1", // just above it
    "192.167.255.255", // just below 192.168/16
    "192.169.0.1", // just above it
    "100.63.255.255", // just below CGNAT
    "100.128.0.1", // just above CGNAT
    "9.255.255.255", // just below 10/8
    "11.0.0.1", // just above 10/8
    "126.255.255.255", // just below 127/8
    "128.0.0.1", // just above 127/8
    "169.253.255.255", // just below link-local
    "169.255.0.1", // just above link-local
    "223.255.255.255", // just below multicast
  ])("permits public %s", (ip) => {
    expect(isBlockedIpv4(ip)).toBe(false);
  });
});

describe("isBlockedIpv6", () => {
  it.each([
    "::1", // loopback
    "::", // unspecified
    "fe80::1", // link-local
    "febf::1", // top of link-local /10
    "fc00::1", // unique-local
    "fd12:3456::1",
    "ff02::1", // multicast
    "::ffff:127.0.0.1", // IPv4-mapped loopback
    "::ffff:10.0.0.1", // IPv4-mapped private
    "::ffff:169.254.169.254", // IPv4-mapped metadata
  ])("blocks private/internal %s", (ip) => {
    expect(isBlockedIpv6(ip)).toBe(true);
  });

  it.each([
    "2001:4860:4860::8888", // public (Google DNS)
    "2606:4700:4700::1111", // public (Cloudflare DNS)
    "::ffff:8.8.8.8", // IPv4-mapped public
  ])("permits public %s", (ip) => {
    expect(isBlockedIpv6(ip)).toBe(false);
  });

  it("ignores a zone id when classifying", () => {
    expect(isBlockedIpv6("fe80::1%eth0")).toBe(true);
  });
});

describe("isBlockedHostname", () => {
  it.each([
    "localhost",
    "LOCALHOST",
    "foo.localhost",
    "anything.local",
    "metadata.google.internal",
    "svc.internal",
    "redis", // single-label container/service name
    "db",
    "internal-api",
  ])("blocks internal name %s", (host) => {
    expect(isBlockedHostname(host)).toBe(true);
  });

  it.each([
    "example.com",
    "api.acme.example",
    "hooks.stripe.com",
    "sub.domain.co.uk",
  ])("permits public name %s", (host) => {
    expect(isBlockedHostname(host)).toBe(false);
  });

  it("strips a trailing FQDN-root dot before classifying", () => {
    expect(isBlockedHostname("example.com.")).toBe(false);
    expect(isBlockedHostname("localhost.")).toBe(true);
  });
});

describe("isBlockedHost (dispatch by family)", () => {
  it("routes literal IPv4, IPv6, and hostnames to the right classifier", () => {
    expect(isBlockedHost("127.0.0.1")).toBe(true);
    expect(isBlockedHost("::1")).toBe(true);
    expect(isBlockedHost("redis")).toBe(true);
    expect(isBlockedHost("8.8.8.8")).toBe(false);
    expect(isBlockedHost("example.com")).toBe(false);
  });
});

describe("isUrlDeliverable / assertUrlDeliverable", () => {
  it("permits a public https URL when blocking is on", () => {
    expect(isUrlDeliverable("https://hooks.acme.example/webhook", BLOCK)).toBe(true);
    expect(() => assertUrlDeliverable("https://hooks.acme.example/webhook", BLOCK)).not.toThrow();
  });

  it.each([
    "http://127.0.0.1:6379/",
    "http://localhost:8080/hook",
    "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
    "http://10.0.0.5/admin",
    "http://[::1]:9200/", // bracketed IPv6 literal in a URL
    "http://redis:6379/",
    "https://metadata.google.internal/computeMetadata/v1/",
  ])("blocks internal destination %s", (url) => {
    expect(isUrlDeliverable(url, BLOCK)).toBe(false);
    expect(() => assertUrlDeliverable(url, BLOCK)).toThrow(BlockedUrlError);
  });

  it("strips IPv6 brackets from the URL host before classifying", () => {
    expect(isUrlDeliverable("http://[fe80::1]/", BLOCK)).toBe(false);
    expect(isUrlDeliverable("http://[2606:4700:4700::1111]/", BLOCK)).toBe(true);
  });

  it("allows everything when allowPrivateNetworks is set (guard disabled)", () => {
    expect(isUrlDeliverable("http://127.0.0.1:6379/", ALLOW)).toBe(true);
    expect(isUrlDeliverable("http://169.254.169.254/", ALLOW)).toBe(true);
    expect(() => assertUrlDeliverable("http://localhost/hook", ALLOW)).not.toThrow();
  });

  it("defers an unparseable URL to the store's syntactic validation (no-op)", () => {
    // URL *syntax* is the endpoint store's job; this guard only judges where a
    // well-formed URL points, so a malformed string passes through untouched.
    expect(isUrlDeliverable("not a url", BLOCK)).toBe(true);
    expect(() => assertUrlDeliverable("not a url", BLOCK)).not.toThrow();
  });

  it("carries a machine-readable reason and an actionable message", () => {
    try {
      assertUrlDeliverable("http://169.254.169.254/", BLOCK);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(BlockedUrlError);
      expect((err as BlockedUrlError).reason).toBe("blocked_host");
      expect((err as BlockedUrlError).message).toContain("169.254.169.254");
      expect((err as BlockedUrlError).message).toContain(
        "POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS",
      );
    }
  });
});
