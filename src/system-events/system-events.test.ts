/**
 * Unit tests for the system-events module — specifically {@link emitEndpointDisabledEvent}.
 *
 * The transport is injected so these tests run without any real HTTP and can
 * inspect the signed headers and body to verify correctness.
 */

import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { verify, HEADERS } from "../signing/webhook-signature.js";
import {
  emitEndpointDisabledEvent,
  emitMessageDeadLetteredEvent,
  systemEventTransportFrom,
  type SystemWebhookConfig,
  type SystemEventTransport,
} from "./index.js";
import type {
  Transport,
  HttpDeliveryRequest,
  HttpDeliveryResponse,
} from "../worker/delivery-worker.js";
import { createGuardedTransport } from "../net/guarded-transport.js";
import { createGuardedLookup, type AddressResolver } from "../net/guarded-lookup.js";
import { BlockedUrlError, type SsrfPolicy } from "../net/ssrf-guard.js";

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

describe("systemEventTransportFrom", () => {
  /** A fake delivery {@link Transport} that records what it received and returns a fixed response. */
  function recordingTransport(response: HttpDeliveryResponse = { status: 202 }) {
    const calls: { request: HttpDeliveryRequest; signal: AbortSignal }[] = [];
    const transport: Transport = (request, signal) => {
      calls.push({ request, signal });
      return Promise.resolve(response);
    };
    return { transport, calls };
  }

  it("forwards url/headers/body as a POST and returns the transport's status", async () => {
    const { transport, calls } = recordingTransport({ status: 202 });
    const send = systemEventTransportFrom(transport);

    const res = await send("https://ops.example/hook", {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": "sys_x" },
      body: '{"event":"endpoint.disabled"}',
    });

    expect(res).toEqual({ status: 202 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request).toEqual({
      url: "https://ops.example/hook",
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": "sys_x" },
      body: '{"event":"endpoint.disabled"}',
    });
  });

  it("supplies a non-aborted signal when the caller passes none (fire-and-forget)", async () => {
    const { transport, calls } = recordingTransport();
    const send = systemEventTransportFrom(transport);
    await send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" });
    const { signal } = calls[0]!;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  it("forwards an explicit caller signal unchanged", async () => {
    const { transport, calls } = recordingTransport();
    const send = systemEventTransportFrom(transport);
    const controller = new AbortController();
    await send("https://ops.example/hook", {
      method: "POST",
      headers: {},
      body: "{}",
      signal: controller.signal,
    });
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("rejects when the underlying transport rejects (fail-closed; never swallowed)", async () => {
    const transport: Transport = () => Promise.reject(new Error("boom"));
    const send = systemEventTransportFrom(transport);
    await expect(
      send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" }),
    ).rejects.toThrow("boom");
  });

  it("aborts the request after timeoutMs when the caller passes no signal", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      // A transport that never settles on its own — only the timeout can end it.
      const transport: Transport = (_request, signal) => {
        capturedSignal = signal;
        return new Promise<HttpDeliveryResponse>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted by timeout")));
        });
      };
      const send = systemEventTransportFrom(transport, { timeoutMs: 5000 });
      const promise = send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" });
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
      expect(capturedSignal!.aborted).toBe(false);
      vi.advanceTimersByTime(5000);
      await expect(promise).rejects.toThrow("aborted by timeout");
      expect(capturedSignal!.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when the transport resolves first (no late abort)", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = recordingTransport({ status: 200 });
      const send = systemEventTransportFrom(transport, { timeoutMs: 5000 });
      const res = await send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" });
      expect(res).toEqual({ status: 200 });
      // Advancing past the deadline must not abort a signal for a finished request.
      vi.advanceTimersByTime(60_000);
      expect(calls[0]!.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets a caller-supplied signal win over the configured timeout", async () => {
    const { transport, calls } = recordingTransport();
    const send = systemEventTransportFrom(transport, { timeoutMs: 5000 });
    const controller = new AbortController();
    await send("https://ops.example/hook", {
      method: "POST",
      headers: {},
      body: "{}",
      signal: controller.signal,
    });
    expect(calls[0]!.signal).toBe(controller.signal);
  });

  it("with timeoutMs 0 supplies a never-aborting signal (preserves fire-and-forget)", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = recordingTransport();
      const send = systemEventTransportFrom(transport, { timeoutMs: 0 });
      await send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" });
      vi.advanceTimersByTime(1_000_000);
      expect(calls[0]!.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the timeout when the transport rejects first (no late abort)", async () => {
    vi.useFakeTimers();
    try {
      let capturedSignal: AbortSignal | undefined;
      const transport: Transport = (_request, signal) => {
        capturedSignal = signal;
        return Promise.reject(new Error("boom"));
      };
      const send = systemEventTransportFrom(transport, { timeoutMs: 5000 });
      await expect(
        send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" }),
      ).rejects.toThrow("boom");
      vi.advanceTimersByTime(60_000);
      expect(capturedSignal!.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces POST method regardless of init.method", async () => {
    const { transport, calls } = recordingTransport({ status: 202 });
    const send = systemEventTransportFrom(transport);

    await send("https://ops.example/hook", {
      method: "GET", // attempt to override
      headers: {},
      body: "{}",
    });

    expect(calls[0]!.request.method).toBe("POST");
  });

  it("handles negative timeoutMs as no-timeout (preserves fire-and-forget)", async () => {
    vi.useFakeTimers();
    try {
      const { transport, calls } = recordingTransport();
      const send = systemEventTransportFrom(transport, { timeoutMs: -1000 });
      await send("https://ops.example/hook", { method: "POST", headers: {}, body: "{}" });
      vi.advanceTimersByTime(1_000_000);
      expect(calls[0]!.signal.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("propagates a connection-time SSRF block from the guarded transport", async () => {
    // Wrap a guarded transport whose DNS resolution is pinned to the cloud-metadata
    // address — the same connection-time defense the tenant delivery path uses. The
    // system-event transport must surface the BlockedUrlError, proving a system webhook
    // that resolves to a private/internal IP is refused before any bytes are sent.
    const policy: SsrfPolicy = { allowPrivateNetworks: false };
    const resolver: AddressResolver = (_h, _o, cb) =>
      cb(null, [{ address: "169.254.169.254", family: 4 } as LookupAddress]);
    const guarded = createGuardedTransport(policy, {
      lookup: createGuardedLookup(policy, resolver),
    });
    const send = systemEventTransportFrom(guarded);

    await expect(
      send("http://metadata.example/hook", { method: "POST", headers: {}, body: "{}" }),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });
});
