import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_DATA_DIR,
  DEFAULT_HOST,
  DEFAULT_PORT,
  MEMORY_DATA_DIR,
  loadConfig,
  type Env,
} from "./config.js";
import { DEFAULT_MAX_BODY_BYTES } from "../http/server.js";
import {
  DEFAULT_IDLE_POLL_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_WORKER_BATCH_SIZE,
} from "../worker/delivery-worker.js";
import {
  DEFAULT_FANOUT_BATCH_SIZE,
  DEFAULT_FANOUT_GRACE_MS,
  DEFAULT_FANOUT_IDLE_POLL_MS,
} from "../fanout/fanout-dispatcher.js";
import { DEFAULT_VISIBILITY_TIMEOUT_MS } from "../queue/delivery-queue.js";

describe("loadConfig", () => {
  it("applies defaults for an empty environment", () => {
    const config = loadConfig({});
    expect(config).toEqual({
      host: DEFAULT_HOST,
      port: DEFAULT_PORT,
      dataDir: DEFAULT_DATA_DIR,
      maxBodyBytes: DEFAULT_MAX_BODY_BYTES,
      worker: {
        batchSize: DEFAULT_WORKER_BATCH_SIZE,
        requestTimeoutMs: DEFAULT_REQUEST_TIMEOUT_MS,
        idlePollMs: DEFAULT_IDLE_POLL_MS,
        visibilityTimeoutMs: DEFAULT_VISIBILITY_TIMEOUT_MS,
      },
      fanout: {
        graceMs: DEFAULT_FANOUT_GRACE_MS,
        batchSize: DEFAULT_FANOUT_BATCH_SIZE,
        idlePollMs: DEFAULT_FANOUT_IDLE_POLL_MS,
      },
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
      POSTHORN_WORKER_REQUEST_TIMEOUT_MS: "5000",
      POSTHORN_WORKER_IDLE_POLL_MS: "250",
      POSTHORN_WORKER_VISIBILITY_TIMEOUT_MS: "60000",
    });
    expect(config.worker).toEqual({
      batchSize: 32,
      requestTimeoutMs: 5000,
      idlePollMs: 250,
      visibilityTimeoutMs: 60_000,
    });
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
});
