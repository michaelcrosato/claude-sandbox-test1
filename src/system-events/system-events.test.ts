/**
 * Unit tests for the system-events module — specifically {@link emitEndpointDisabledEvent}.
 *
 * The transport is injected so these tests run without any real HTTP and can
 * inspect the signed headers and body to verify correctness.
 */

import { describe, expect, it, vi } from "vitest";
import { verify, HEADERS } from "../signing/webhook-signature.js";
import {
  emitEndpointDisabledEvent,
  emitMessageDeadLetteredEvent,
  type SystemWebhookConfig,
  type SystemEventTransport,
} from "./index.js";

/** A minimal endpoint snapshot stub for tests. */
const ENDPOINT_STUB = {
  id: "ep_test_1",
  appId: "app_test_1",
  url: "https://receiver.example/webhook",
  disabled: true,
  consecutiveFailures: 3,
  firstFailureAt: 1_700_000_000_000,
};

const CONFIG: SystemWebhookConfig = {
  url: "https://ops.example/system-hook",
  secret: "whsec_dGVzdHNlY3JldA==", // "testsecret" base64-encoded
};

describe("emitEndpointDisabledEvent", () => {
  it("calls the transport with POST to the configured URL", async () => {
    const transport: SystemEventTransport = vi.fn().mockResolvedValue({ status: 200 });
    await emitEndpointDisabledEvent(CONFIG, ENDPOINT_STUB, {
      transport,
      now: () => 1_700_100_000_000,
    });
    expect(transport).toHaveBeenCalledOnce();
    const firstCall = (transport as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ];
    const [url, init] = firstCall;
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe("POST");
  });

  it("sends a JSON body with event = endpoint.disabled and correct data", async () => {
    let capturedBody = "";
    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedBody = init.body;
      return Promise.resolve({ status: 200 });
    });
    const nowMs = 1_700_100_000_000;
    await emitEndpointDisabledEvent(CONFIG, ENDPOINT_STUB, {
      transport,
      now: () => nowMs,
    });

    const payload = JSON.parse(capturedBody) as {
      event: string;
      data: {
        endpointId: string;
        appId: string;
        url: string;
        disabled: boolean;
        consecutiveFailures: number;
        firstFailureAt: number | null;
        disabledAt: number;
      };
    };
    expect(payload.event).toBe("endpoint.disabled");
    expect(payload.data.endpointId).toBe(ENDPOINT_STUB.id);
    expect(payload.data.appId).toBe(ENDPOINT_STUB.appId);
    expect(payload.data.url).toBe(ENDPOINT_STUB.url);
    expect(payload.data.disabled).toBe(true);
    expect(payload.data.consecutiveFailures).toBe(ENDPOINT_STUB.consecutiveFailures);
    expect(payload.data.firstFailureAt).toBe(ENDPOINT_STUB.firstFailureAt);
    expect(payload.data.disabledAt).toBe(nowMs);
  });

  it("includes Standard Webhooks headers (id, timestamp, signature)", async () => {
    let capturedHeaders: Record<string, string> = {};
    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init.headers;
      return Promise.resolve({ status: 200 });
    });
    await emitEndpointDisabledEvent(CONFIG, ENDPOINT_STUB, {
      transport,
      now: () => 1_700_100_000_000,
    });

    expect(capturedHeaders[HEADERS.id]).toBeDefined();
    expect(capturedHeaders[HEADERS.id]!.startsWith("sys_")).toBe(true);
    expect(capturedHeaders[HEADERS.timestamp]).toBeDefined();
    expect(capturedHeaders[HEADERS.signature]).toBeDefined();
    expect(capturedHeaders[HEADERS.signature]!.startsWith("v1,")).toBe(true);
    expect(capturedHeaders["content-type"]).toBe("application/json");
  });

  it("produces a verifiable Standard Webhooks signature", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const nowMs = 1_700_100_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return Promise.resolve({ status: 200 });
    });
    await emitEndpointDisabledEvent(CONFIG, ENDPOINT_STUB, {
      transport,
      now: () => nowMs,
    });

    // Should not throw — signature is valid.
    expect(() =>
      verify(
        CONFIG.secret,
        {
          id: capturedHeaders[HEADERS.id]!,
          timestamp: capturedHeaders[HEADERS.timestamp]!,
          signature: capturedHeaders[HEADERS.signature]!,
        },
        capturedBody,
        { now: nowSec },
      ),
    ).not.toThrow();
  });

  it("does not swallow transport errors (rejects on failure)", async () => {
    const transport: SystemEventTransport = vi.fn().mockRejectedValue(new Error("network down"));
    await expect(
      emitEndpointDisabledEvent(CONFIG, ENDPOINT_STUB, {
        transport,
        now: () => 1_700_100_000_000,
      }),
    ).rejects.toThrow("network down");
  });

  it("produces a verifiable signature with an sws_-prefixed secret (standard format)", async () => {

    // Generate a deterministic sws_ secret: sws_ + base64url of known bytes.
    // "testsecret" → base64url (URL-safe, no padding) = "dGVzdHNlY3JldA"
    const swsSecret = "sws_dGVzdHNlY3JldA";
    const swsConfig: SystemWebhookConfig = {
      url: "https://ops.example/system-hook",
      secret: swsSecret,
    };

    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const nowMs = 1_700_100_000_000;
    const nowSec = Math.floor(nowMs / 1000);

    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return Promise.resolve({ status: 200 });
    });
    await emitEndpointDisabledEvent(swsConfig, ENDPOINT_STUB, {
      transport,
      now: () => nowMs,
    });

    // Verify with the equivalent whsec_ secret — same raw bytes, different prefix/format.
    // sws_dGVzdHNlY3JldA (base64url) → "testsecret" → whsec_dGVzdHNlY3JldA==
    expect(() =>
      verify(
        "whsec_dGVzdHNlY3JldA==",
        {
          id: capturedHeaders[HEADERS.id]!,
          timestamp: capturedHeaders[HEADERS.timestamp]!,
          signature: capturedHeaders[HEADERS.signature]!,
        },
        capturedBody,
        { now: nowSec },
      ),
    ).not.toThrow();
  });
});

describe("emitMessageDeadLetteredEvent", () => {
  const INFO = {
    messageId: "msg_test_1",
    endpointId: "ep_test_1",
    appId: "app_test_1",
  } as const;

  it("calls the transport with POST to the configured URL", async () => {
    const transport: SystemEventTransport = vi.fn().mockResolvedValue({ status: 200 });
    await emitMessageDeadLetteredEvent(CONFIG, INFO, {
      transport,
      now: () => 1_700_100_000_000,
    });
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = (transport as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      { method: string },
    ];
    expect(url).toBe(CONFIG.url);
    expect(init.method).toBe("POST");
  });

  it("sends a JSON body with event = message.dead_lettered and correct data", async () => {
    let capturedBody = "";
    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedBody = init.body;
      return Promise.resolve({ status: 200 });
    });
    const nowMs = 1_700_100_000_000;
    await emitMessageDeadLetteredEvent(CONFIG, INFO, {
      transport,
      now: () => nowMs,
    });

    const payload = JSON.parse(capturedBody) as {
      event: string;
      data: { messageId: string; endpointId: string | null; appId: string | null; deadLetteredAt: number };
    };
    expect(payload.event).toBe("message.dead_lettered");
    expect(payload.data.messageId).toBe(INFO.messageId);
    expect(payload.data.endpointId).toBe(INFO.endpointId);
    expect(payload.data.appId).toBe(INFO.appId);
    expect(payload.data.deadLetteredAt).toBe(nowMs);
  });

  it("accepts null endpointId and null appId", async () => {
    let capturedBody = "";
    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedBody = init.body;
      return Promise.resolve({ status: 200 });
    });
    await emitMessageDeadLetteredEvent(
      CONFIG,
      { messageId: "msg_x", endpointId: null, appId: null },
      { transport, now: () => 1_700_100_000_000 },
    );
    const payload = JSON.parse(capturedBody) as { data: { endpointId: null; appId: null } };
    expect(payload.data.endpointId).toBeNull();
    expect(payload.data.appId).toBeNull();
  });

  it("includes Standard Webhooks headers and a verifiable signature", async () => {
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const nowMs = 1_700_100_000_000;
    const nowSec = Math.floor(nowMs / 1000);
    const transport: SystemEventTransport = vi.fn().mockImplementation((_url, init) => {
      capturedHeaders = init.headers;
      capturedBody = init.body;
      return Promise.resolve({ status: 200 });
    });
    await emitMessageDeadLetteredEvent(CONFIG, INFO, { transport, now: () => nowMs });

    expect(capturedHeaders[HEADERS.id]!.startsWith("sys_")).toBe(true);
    expect(capturedHeaders[HEADERS.timestamp]).toBeDefined();
    expect(capturedHeaders[HEADERS.signature]!.startsWith("v1,")).toBe(true);
    expect(() =>
      verify(CONFIG.secret, {
        id: capturedHeaders[HEADERS.id]!,
        timestamp: capturedHeaders[HEADERS.timestamp]!,
        signature: capturedHeaders[HEADERS.signature]!,
      }, capturedBody, { now: nowSec }),
    ).not.toThrow();
  });

  it("does not swallow transport errors (rejects on failure)", async () => {
    const transport: SystemEventTransport = vi.fn().mockRejectedValue(new Error("net fail"));
    await expect(
      emitMessageDeadLetteredEvent(CONFIG, INFO, { transport, now: () => 1_700_100_000_000 }),
    ).rejects.toThrow("net fail");
  });
});
