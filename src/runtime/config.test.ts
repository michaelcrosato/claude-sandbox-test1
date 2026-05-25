import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MEMORY_DATA_DIR,
  MIN_ADMIN_TOKEN_LENGTH,
  loadConfig,
  type Env,
} from "./config.js";
import { MAX_RATE_LIMIT } from "../endpoints/endpoint.js";
import { DEFAULT_MAX_BODY_BYTES } from "../http/server.js";
import {
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WORKER_BATCH_SIZE,
  DEFAULT_WORKER_CONCURRENCY,
} from "../worker/delivery-worker.js";
import {
  DEFAULT_FANOUT_BATCH_SIZE,
  DEFAULT_FANOUT_GRACE_MS,
  DEFAULT_FANOUT_IDLE_POLL_MS,
} from "../fanout/fanout-dispatcher.js";
import { DEFAULT_VISIBILITY_TIMEOUT_MS } from "../queue/delivery-queue.js";
import { DEFAULT_AUTO_DISABLE_AFTER_MS } from "../endpoints/endpoint.js";
import { DEFAULT_CONNECT_TIMEOUT_MS } from "../net/guarded-transport.js";
import { DEFAULT_LOG_LEVEL } from "../logging/logger.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      dataDir: DEFAULT_DATA_DIR,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      publicBaseUrl: null,
      adminToken: null,
      endpointAutoDisableAfterMs: DEFAULT_AUTO_DISABLE_AFTER_MS,
      worker: {
        batchSize: DEFAULT_WORKER_BATCH_SIZE,
        concurrency: DEFAULT_WORKER_CONCURRENCY,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_MS,
        idlePollMs: DEFAULT_IDLE_POLL_MS,
        visibilityTimeoutMs: DEFAULT_VISIBILITY_TIMEOUT_MS,
      },
      retentionDays: 0,
      defaultRateLimit: null,
      allowPrivateNetworks: false,
      logLevel: DEFAULT_LOG_LEVEL,
      hsts: { maxAgeSeconds: 0, includeSubDomains: false, preload: false },
      fanout: {
        graceMs: DEFAULT_FANOUT_GRACE_MS,
        batchSize: DEFAULT_FANOUT_BATCH_SIZE,
        idlePollMs: DEFAULT_FANOUT_IDLE_POLL_MS,
      },
    });
  });

  describe("POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS (SSRF guard opt-out)", () => {
    it("defaults to false (block private/internal destinations)", () => {
      expect(loadConfig({}).allowPrivateNetworks).toBe(false);
    });

    it.each([
      ["true", true],
      ["TRUE", true],
      ["  true  ", true],
      ["1", true],
      ["false", false],
      ["0", false],
    ] as const)("parses %j → %s", (raw, expected) => {
      expect(
        loadConfig({ POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: raw }).allowPrivateNetworks,
      ).toBe(expected);
    });

    it("treats blank as unset (false)", () => {
      expect(
        loadConfig({ POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "  " }).allowPrivateNetworks,
      ).toBe(false);
    });

    it("rejects a non-boolean value with a ConfigError", () => {
      expect(() =>
        loadConfig({ POSTHORN_ALLOW_PRIVATE_NETWORK_WEBHOOKS: "yes" }),
      ).toThrow(ConfigError);
    });
  });

  describe("POSTHORN_HSTS_* (Strict-Transport-Security)", () => {
    it("defaults to disabled (max-age 0, no modifiers)", () => {
      expect(loadConfig({}).hsts).toEqual({
        maxAgeSeconds: 0,
        includeSubDomains: false,
        preload: false,
      });
    });

    it("reads a bare max-age (modifiers default off)", () => {
      expect(loadConfig({ POSTHORN_HSTS_MAX_AGE: "31536000" }).hsts).toEqual({
        maxAgeSeconds: 31_536_000,
        includeSubDomains: false,
        preload: false,
      });
    });

    it("reads max-age + includeSubDomains together", () => {
      expect(
        loadConfig({
          POSTHORN_HSTS_MAX_AGE: "63072000",
          POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true",
        }).hsts,
      ).toEqual({ maxAgeSeconds: 63_072_000, includeSubDomains: true, preload: false });
    });

    it("accepts a preload config that satisfies the preload-list rules", () => {
      expect(
        loadConfig({
          POSTHORN_HSTS_MAX_AGE: "31536000",
          POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true",
          POSTHORN_HSTS_PRELOAD: "true",
        }).hsts,
      ).toEqual({ maxAgeSeconds: 31_536_000, includeSubDomains: true, preload: true });
    });

    it("rejects a modifier set without a max-age (nothing to extend)", () => {
      expect(() =>
        loadConfig({ POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true" }),
      ).toThrow(/require POSTHORN_HSTS_MAX_AGE > 0/);
      expect(() => loadConfig({ POSTHORN_HSTS_PRELOAD: "true" })).toThrow(ConfigError);
    });

    it("rejects preload without includeSubDomains (preload-list rule)", () => {
      expect(() =>
        loadConfig({ POSTHORN_HSTS_MAX_AGE: "31536000", POSTHORN_HSTS_PRELOAD: "true" }),
      ).toThrow(/requires POSTHORN_HSTS_INCLUDE_SUBDOMAINS=true/);
    });

    it("rejects preload with a max-age below the one-year preload-list floor", () => {
      expect(() =>
        loadConfig({
          POSTHORN_HSTS_MAX_AGE: "86400",
          POSTHORN_HSTS_INCLUDE_SUBDOMAINS: "true",
          POSTHORN_HSTS_PRELOAD: "true",
        }),
      ).toThrow(/POSTHORN_HSTS_MAX_AGE >= 31536000/);
    });

    it("rejects a negative max-age", () => {
      expect(() => loadConfig({ POSTHORN_HSTS_MAX_AGE: "-1" })).toThrow(ConfigError);
    });
  });

  it("treats blank/whitespace values as unset (falls back to defaults)", () => {
    const config = loadConfig({
      POSTHORN_HOST: "  ",
      POSTHORN_PORT: "",
      POSTHORN_DATA_DIR: "   ",
    });
    expect(config.host).toBe(DEFAULT_HOST);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
  });

  it("reads and trims string overrides", () => {
    const config = loadConfig({
      POSTHORN_HOST: " 127.0.0.1 ",
      POSTHORN_DATA_DIR: " /var/lib/posthorn ",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.dataDir).toBe("/var/lib/posthorn");
  });

  it("accepts the in-memory data dir sentinel", () => {
    expect(loadConfig({ POSTHORN_DATA_DIR: MEMORY_DATA_DIR }).dataDir).toBe(
      MEMORY_DATA_DIR,
    );
  });

  it("parses a valid port and the ephemeral port 0", () => {
    expect(loadConfig({ POSTHORN_PORT: "8080" }).port).toBe(8080);
    expect(loadConfig({ POSTHORN_PORT: "0" }).port).toBe(0);
    expect(loadConfig({ POSTHORN_PORT: "65535" }).port).toBe(65_535);
  });

  it("rejects a non-integer port", () => {
    expect(() => loadConfig({ POSTHORN_PORT: "abc" })).toThrow(ConfigError);
    expect(() => loadConfig({ POSTHORN_PORT: "80.5" })).toThrow(/POSTHORN_PORT/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ POSTHORN_PORT: "-1" })).toThrow(ConfigError);
    expect(() => loadConfig({ POSTHORN_PORT: "70000" })).toThrow(/between 0 and 65535/);
  });

  it("parses worker tunables", () => {
    const config = loadConfig({
      POSTHORN_WORKER_BATCH_SIZE: "32",
      POSTHORN_WORKER_CONCURRENCY: "12",
      POSTHORN_WORKER_REQUEST_TIMEOUT_MS: "5000",
      POSTHORN_WORKER_CONNECT_TIMEOUT_MS: "2500",
      POSTHORN_WORKER_IDLE_POLL_MS: "250",
      POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS: "60000",
    });
    expect(config.worker).toEqual({
      batchSize: 32,
      concurrency: 12,
      requestTimeoutMs: 5000,
      connectTimeoutMs: 2500,
      idlePollMs: 250,
      visibilityTimeoutMs: 60_000,
    });
  });

  it("allows a connect timeout of 0 (disabled) but rejects a negative one", () => {
    expect(loadConfig({ POSTHORN_WORKER_CONNECT_TIMEOUT_MS: "0" }).worker.connectTimeoutMs).toBe(
      0,
    );
    expect(() => loadConfig({ POSTHORN_WORKER_CONNECT_TIMEOUT_MS: "-1" })).toThrow(
      /POSTHORN_WORKER_CONNECT_TIMEOUT_MS/,
    );
  });

  it("rejects a non-positive worker concurrency", () => {
    expect(loadConfig({ POSTHORN_WORKER_CONCURRENCY: "1" }).worker.concurrency).toBe(1);
    expect(() => loadConfig({ POSTHORN_WORKER_CONCURRENCY: "0" })).toThrow(
      /POSTHORN_WORKER_CONCURRENCY/,
    );
  });

  it("parses fan-out dispatcher tunables", () => {
    const config = loadConfig({
      POSTHORN_FANOUT_GRACE_MS: "5000",
      POSTHORN_FANOUT_BATCH_SIZE: "250",
      POSTHORN_FANOUT_IDLE_POLL_MS: "100",
    });
    expect(config.fanout).toEqual({
      graceMs: 5000,
      batchSize: 250,
      idlePollMs: 100,
    });
  });

  it("allows a fan-out grace/idle poll of 0 but rejects a zero fan-out batch size", () => {
    expect(loadConfig({ POSTHORN_FANOUT_GRACE_MS: "0" }).fanout.graceMs).toBe(0);
    expect(loadConfig({ POSTHORN_FANOUT_IDLE_POLL_MS: "0" }).fanout.idlePollMs).toBe(0);
    expect(() => loadConfig({ POSTHORN_FANOUT_BATCH_SIZE: "0" })).toThrow(
      /POSTHORN_FANOUT_BATCH_SIZE/,
    );
  });

  it("allows an idle poll of 0 but rejects a zero batch size or timeout", () => {
    expect(loadConfig({ POSTHORN_WORKER_IDLE_POLL_MS: "0" }).worker.idlePollMs).toBe(0);
    expect(() => loadConfig({ POSTHORN_WORKER_BATCH_SIZE: "0" })).toThrow(
      /POSTHORN_WORKER_BATCH_SIZE/,
    );
    expect(() => loadConfig({ POSTHORN_WORKER_REQUEST_TIMEOUT_MS: "0" })).toThrow(
      /POSTHORN_WORKER_REQUEST_TIMEOUT_MS/,
    );
  });

  it("rejects a non-positive max body size", () => {
    expect(loadConfig({ POSTHORN_MAX_BODY_BYTES: "2048" }).maxBodyBytes).toBe(2048);
    expect(() => loadConfig({ POSTHORN_MAX_BODY_BYTES: "0" })).toThrow(ConfigError);
  });

  it("returns a deeply frozen, immutable config", () => {
    const config = loadConfig({});
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.worker)).toBe(true);
    expect(Object.isFrozen(config.fanout)).toBe(true);
    expect(() => {
      (config as { port: number }).port = 1;
    }).toThrow(TypeError);
  });

  it("names the offending key in the error message", () => {
    const env: Env = { POSTHORN_WORKER_BATCH_SIZE: "nope" };
    expect(() => loadConfig(env)).toThrow(/POSTHORN_WORKER_BATCH_SIZE must be an integer/);
  });

  describe("POSTHORN_ADMIN_TOKEN", () => {
    it("defaults to null (admin API disabled) when unset or blank", () => {
      expect(loadConfig({}).adminToken).toBeNull();
      expect(loadConfig({ POSTHORN_ADMIN_TOKEN: "   " }).adminToken).toBeNull();
    });

    it("accepts and trims a sufficiently long token", () => {
      const token = "x".repeat(MIN_ADMIN_TOKEN_LENGTH);
      expect(loadConfig({ POSTHORN_ADMIN_TOKEN: `  ${token}  ` }).adminToken).toBe(token);
    });

    it("rejects a token shorter than the minimum length", () => {
      const tooShort = "x".repeat(MIN_ADMIN_TOKEN_LENGTH - 1);
      expect(() => loadConfig({ POSTHORN_ADMIN_TOKEN: tooShort })).toThrow(ConfigError);
      expect(() => loadConfig({ POSTHORN_ADMIN_TOKEN: tooShort })).toThrow(
        /POSTHORN_ADMIN_TOKEN must be at least/,
      );
    });
  });

  describe("POSTHORN_PUBLIC_BASE_URL", () => {
    it("defaults to null (derive portal links from the request) when unset or blank", () => {
      expect(loadConfig({}).publicBaseUrl).toBeNull();
      expect(loadConfig({ POSTHORN_PUBLIC_BASE_URL: "   " }).publicBaseUrl).toBeNull();
    });

    it("accepts a bare http/https origin and trims surrounding whitespace", () => {
      expect(loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com" }).publicBaseUrl).toBe(
        "https://hooks.example.com",
      );
      expect(loadConfig({ POSTHORN_PUBLIC_BASE_URL: "  http://localhost  " }).publicBaseUrl).toBe(
        "http://localhost",
      );
    });

    it("normalizes a trailing slash and a default port away to the bare origin", () => {
      expect(loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com/" }).publicBaseUrl).toBe(
        "https://hooks.example.com",
      );
      expect(
        loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com:443" }).publicBaseUrl,
      ).toBe("https://hooks.example.com");
    });

    it("preserves a non-default port", () => {
      expect(
        loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com:8443" }).publicBaseUrl,
      ).toBe("https://hooks.example.com:8443");
    });

    it("rejects a non-http(s) scheme", () => {
      expect(() => loadConfig({ POSTHORN_PUBLIC_BASE_URL: "ftp://hooks.example.com" })).toThrow(
        /must use the http or https scheme/,
      );
      expect(() => loadConfig({ POSTHORN_PUBLIC_BASE_URL: "ws://hooks.example.com" })).toThrow(
        ConfigError,
      );
    });

    it("rejects a value that is not an absolute URL", () => {
      expect(() => loadConfig({ POSTHORN_PUBLIC_BASE_URL: "hooks.example.com" })).toThrow(
        /must be an absolute http\(s\) URL/,
      );
      expect(() => loadConfig({ POSTHORN_PUBLIC_BASE_URL: "not a url" })).toThrow(ConfigError);
    });

    it("rejects a path, query, or fragment beyond the bare origin", () => {
      expect(() =>
        loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com/portal" }),
      ).toThrow(/must be a bare origin/);
      expect(() =>
        loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com/?a=1" }),
      ).toThrow(/must be a bare origin/);
      expect(() =>
        loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://hooks.example.com/#x" }),
      ).toThrow(/must be a bare origin/);
    });

    it("rejects embedded credentials", () => {
      expect(() =>
        loadConfig({ POSTHORN_PUBLIC_BASE_URL: "https://user:pass@hooks.example.com" }),
      ).toThrow(/must not embed credentials/);
    });
  });

  describe("POSTHORN_RETENTION_DAYS", () => {
    it("defaults to 0 (pruning disabled) when unset", () => {
      expect(loadConfig({}).retentionDays).toBe(0);
    });

    it("accepts 0 (explicitly disabling pruning) and valid positive values", () => {
      expect(loadConfig({ POSTHORN_RETENTION_DAYS: "0" }).retentionDays).toBe(0);
      expect(loadConfig({ POSTHORN_RETENTION_DAYS: "30" }).retentionDays).toBe(30);
      expect(loadConfig({ POSTHORN_RETENTION_DAYS: "1" }).retentionDays).toBe(1);
    });

    it("rejects a negative or non-integer value", () => {
      expect(() => loadConfig({ POSTHORN_RETENTION_DAYS: "-1" })).toThrow(ConfigError);
      expect(() => loadConfig({ POSTHORN_RETENTION_DAYS: "1.5" })).toThrow(ConfigError);
      expect(() => loadConfig({ POSTHORN_RETENTION_DAYS: "abc" })).toThrow(ConfigError);
    });
  });

  describe("POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS", () => {
    it("defaults to DEFAULT_AUTO_DISABLE_AFTER_MS", () => {
      expect(loadConfig({}).endpointAutoDisableAfterMs).toBe(DEFAULT_AUTO_DISABLE_AFTER_MS);
    });

    it("reads an override and accepts 0 (auto-disabling off)", () => {
      expect(
        loadConfig({ POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS: "3600000" }).endpointAutoDisableAfterMs,
      ).toBe(3_600_000);
      expect(
        loadConfig({ POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS: "0" }).endpointAutoDisableAfterMs,
      ).toBe(0);
    });

    it("rejects a negative or non-integer value", () => {
      expect(() =>
        loadConfig({ POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS: "-1" }),
      ).toThrow(ConfigError);
      expect(() =>
        loadConfig({ POSTHORN_ENDPOINT_AUTO_DISABLE_AFTER_MS: "1.5" }),
      ).toThrow(ConfigError);
    });
  });

  describe("POSTHORN_DEFAULT_RATE_LIMIT", () => {
    it("defaults to null (no gateway-wide rate limit) when unset or blank", () => {
      expect(loadConfig({}).defaultRateLimit).toBeNull();
      expect(loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "   " }).defaultRateLimit).toBeNull();
    });

    it("accepts a valid positive integer", () => {
      expect(loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "60" }).defaultRateLimit).toBe(60);
      expect(loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "1" }).defaultRateLimit).toBe(1);
      expect(
        loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: String(MAX_RATE_LIMIT) }).defaultRateLimit,
      ).toBe(MAX_RATE_LIMIT);
    });

    it("rejects 0 (not a valid rate limit)", () => {
      expect(() => loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "0" })).toThrow(ConfigError);
      expect(() => loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "0" })).toThrow(
        /POSTHORN_DEFAULT_RATE_LIMIT must be between/,
      );
    });

    it("rejects a negative value", () => {
      expect(() => loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "-1" })).toThrow(ConfigError);
    });

    it("rejects a value exceeding MAX_RATE_LIMIT", () => {
      expect(() =>
        loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: String(MAX_RATE_LIMIT + 1) }),
      ).toThrow(ConfigError);
    });

    it("rejects a non-integer", () => {
      expect(() => loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "1.5" })).toThrow(ConfigError);
      expect(() => loadConfig({ POSTHORN_DEFAULT_RATE_LIMIT: "abc" })).toThrow(
        /POSTHORN_DEFAULT_RATE_LIMIT must be an integer/,
      );
    });
  });

  describe("POSTHORN_LOG_LEVEL", () => {
    it("defaults to info when unset or blank", () => {
      expect(loadConfig({}).logLevel).toBe(DEFAULT_LOG_LEVEL);
      expect(loadConfig({}).logLevel).toBe("info");
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "   " }).logLevel).toBe("info");
    });

    it("accepts each valid level (case-insensitive, trimmed)", () => {
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "debug" }).logLevel).toBe("debug");
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "info" }).logLevel).toBe("info");
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "warn" }).logLevel).toBe("warn");
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "error" }).logLevel).toBe("error");
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "silent" }).logLevel).toBe("silent");
      expect(loadConfig({ POSTHORN_LOG_LEVEL: "  WARN  " }).logLevel).toBe("warn");
    });

    it("rejects an unrecognized level", () => {
      expect(() => loadConfig({ POSTHORN_LOG_LEVEL: "verbose" })).toThrow(ConfigError);
      expect(() => loadConfig({ POSTHORN_LOG_LEVEL: "trace" })).toThrow(
        /POSTHORN_LOG_LEVEL must be one of/,
      );
    });
  });
});

/**
 * Config↔docs drift guard. The set of `POSTHORN_*` variables {@link loadConfig}
 * actually reads is the source of truth; this asserts every one of them is
 * documented for operators in both `.env.example` and `docs/DEPLOY.md`, and that
 * `.env.example` lists no variable the loader does not recognize. It is the same
 * "one source of truth, can't drift" discipline the OpenAPI route table uses: a
 * future tick that adds a config knob without documenting it fails here rather
 * than shipping an invisible feature (the exact regression this tick repaired —
 * `POSTHORN_DEFAULT_RATE_LIMIT`, `POSTHORN_RETENTION_DAYS`, and
 * `POSTHORN_MAX_BODY_BYTES` had landed in the loader but not the docs).
 */
describe("config documentation", () => {
  /**
   * The exact env keys {@link loadConfig} reads, captured by probing it with a
   * Proxy that records every property access. No source parsing, no
   * hand-maintained list — the guard tracks real loader behavior. Every read
   * returns `undefined`, so the loader takes all defaults and never throws.
   */
  function recognizedEnvKeys(): string[] {
    const accessed = new Set<string>();
    const probe = new Proxy({} as Record<string, string | undefined>, {
      get(_target, prop) {
        if (typeof prop === "string") accessed.add(prop);
        return undefined;
      },
    });
    loadConfig(probe);
    return [...accessed].filter((k) => k.startsWith("POSTHORN_")).sort();
  }

  const read = (rel: string): string =>
    readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  const recognized = recognizedEnvKeys();
  const envExample = read("../../.env.example");
  const deployDoc = read("../../docs/DEPLOY.md");

  it("captures the full recognized variable set (probe sanity check)", () => {
    // If the Proxy probe ever silently captured nothing, the per-key checks below
    // would vacuously pass; this floor makes that failure mode loud instead.
    expect(recognized.length).toBeGreaterThanOrEqual(16);
  });

  it.each(recognized)("%s is documented in .env.example", (key) => {
    expect(envExample).toContain(key);
  });

  it.each(recognized)("%s is documented in docs/DEPLOY.md", (key) => {
    expect(deployDoc).toContain(key);
  });

  it("lists no unrecognized POSTHORN_* variable in .env.example", () => {
    const assigned: string[] = [];
    for (const m of envExample.matchAll(/^(POSTHORN_[A-Z0-9_]+)=/gm)) {
      assigned.push(m[1]!);
    }
    expect(assigned.length).toBeGreaterThan(0);
    const known = new Set(recognized);
    for (const key of assigned) {
      expect(known.has(key), `${key} in .env.example is not read by loadConfig`).toBe(true);
    }
  });
});
