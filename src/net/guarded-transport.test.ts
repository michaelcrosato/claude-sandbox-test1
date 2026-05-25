import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { LookupAddress } from "node:dns";

import { MAX_CAPTURED_BODY_BYTES } from "../attempts/delivery-attempt.js";
import type { HttpDeliveryRequest } from "../worker/delivery-worker.js";
import { BlockedUrlError, type SsrfPolicy } from "./ssrf-guard.js";
import { createGuardedLookup, type AddressResolver } from "./guarded-lookup.js";
import { createGuardedTransport } from "./guarded-transport.js";

const BLOCK: SsrfPolicy = { allowPrivateNetworks: false };
const ALLOW: SsrfPolicy = { allowPrivateNetworks: true };

interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

interface TestReceiver {
  readonly port: number;
  /** Resolves with the first request the receiver captures. */
  readonly received: Promise<Received>;
  close(): Promise<void>;
}

interface ReceiverOptions {
  readonly status?: number;
  readonly responseHeaders?: Record<string, string>;
  readonly responseBody?: string;
  /** If true, the receiver accepts the request but never responds (for abort tests). */
  readonly hang?: boolean;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.map(
      (s) =>
        new Promise<void>((done) => {
          s.closeAllConnections();
          s.close(() => done());
        }),
    ),
  );
  servers.length = 0;
});

function startReceiver(options: ReceiverOptions = {}): Promise<TestReceiver> {
  const { status = 200, responseHeaders = {}, responseBody = "ok", hang = false } = options;
  let resolveReceived!: (req: Received) => void;
  const received = new Promise<Received>((resolve) => {
    resolveReceived = resolve;
  });
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      resolveReceived({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (hang) return; // never respond
      res.writeHead(status, responseHeaders);
      res.end(responseBody);
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        port,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}

function request(url: string, body = '{"hello":"world"}'): HttpDeliveryRequest {
  return {
    url,
    method: "POST",
    headers: {
      "content-type": "application/json",
      "webhook-id": "msg_test",
      "webhook-signature": "v1,deadbeef",
    },
    body,
  };
}

/** A guarded lookup whose underlying resolution is fixed (no real DNS). */
function lookupReturning(policy: SsrfPolicy, addresses: LookupAddress[]) {
  const resolver: AddressResolver = (_h, _o, cb) => cb(null, addresses);
  return createGuardedLookup(policy, resolver);
}

describe("createGuardedTransport — delivery over a literal IP (no DNS)", () => {
  it("POSTs body + headers and returns the status (block policy, literal IP bypasses lookup)", async () => {
    const receiver = await startReceiver({ status: 200, responseBody: "received" });
    const transport = createGuardedTransport(BLOCK);
    const res = await transport(
      request(`http://127.0.0.1:${receiver.port}/hook`),
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(200);
    expect(res.responseBody).toBe("received");
    const got = await receiver.received;
    expect(got.method).toBe("POST");
    expect(got.url).toBe("/hook");
    expect(got.headers["content-type"]).toBe("application/json");
    expect(got.headers["webhook-id"]).toBe("msg_test");
    expect(got.body).toBe('{"hello":"world"}');
  });

  it("surfaces a Retry-After header", async () => {
    const receiver = await startReceiver({
      status: 503,
      responseHeaders: { "retry-after": "30" },
    });
    const transport = createGuardedTransport(BLOCK);
    const res = await transport(
      request(`http://127.0.0.1:${receiver.port}/`),
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(503);
    expect(res.retryAfter).toBe("30");
  });

  it("returns a non-2xx status without throwing", async () => {
    const receiver = await startReceiver({ status: 404 });
    const transport = createGuardedTransport(BLOCK);
    const res = await transport(
      request(`http://127.0.0.1:${receiver.port}/`),
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(404);
  });

  it("does NOT follow redirects — a 3xx is returned as-is (closes a redirect SSRF hop)", async () => {
    const receiver = await startReceiver({
      status: 302,
      responseHeaders: { location: "http://169.254.169.254/" },
    });
    const transport = createGuardedTransport(BLOCK);
    const res = await transport(
      request(`http://127.0.0.1:${receiver.port}/`),
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(302);
  });

  it("truncates a large response body to MAX_CAPTURED_BODY_BYTES characters", async () => {
    const huge = "x".repeat(MAX_CAPTURED_BODY_BYTES * 3);
    const receiver = await startReceiver({ status: 200, responseBody: huge });
    const transport = createGuardedTransport(BLOCK);
    const res = await transport(
      request(`http://127.0.0.1:${receiver.port}/`),
      AbortSignal.timeout(3000),
    );
    expect(res.responseBody).toHaveLength(MAX_CAPTURED_BODY_BYTES);
  });

  it("throws when the per-attempt signal aborts (timeout) before a response", async () => {
    const receiver = await startReceiver({ hang: true });
    const transport = createGuardedTransport(BLOCK);
    await expect(
      transport(request(`http://127.0.0.1:${receiver.port}/`), AbortSignal.timeout(150)),
    ).rejects.toThrow();
  });

  it("throws on an unsupported URL protocol", async () => {
    const transport = createGuardedTransport(BLOCK);
    await expect(
      transport(request("ftp://127.0.0.1/x"), AbortSignal.timeout(1000)),
    ).rejects.toThrow(/protocol/);
  });
});

describe("createGuardedTransport — connection-time SSRF guard on a hostname", () => {
  it("blocks delivery when the destination hostname resolves to a private IP", async () => {
    // The receiver is real, but the hostname resolves (via the injected guarded
    // lookup) to a private IP — so the connection must be refused before connecting.
    const receiver = await startReceiver({ status: 200 });
    const transport = createGuardedTransport(BLOCK, {
      lookup: lookupReturning(BLOCK, [{ address: "10.0.0.5", family: 4 }]),
    });
    await expect(
      transport(
        request(`http://malicious.example:${receiver.port}/hook`),
        AbortSignal.timeout(3000),
      ),
    ).rejects.toBeInstanceOf(BlockedUrlError);
    // The receiver must never have been contacted.
    const contacted = await Promise.race([
      receiver.received.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), 100)),
    ]);
    expect(contacted).toBe(false);
  });

  it("delivers to the pinned address when resolution is allowed", async () => {
    // The hostname resolves to the loopback receiver via the guarded lookup; with the
    // address public-by-policy (opt-out), the transport connects to it and delivers.
    const receiver = await startReceiver({ status: 200, responseBody: "delivered" });
    const transport = createGuardedTransport(ALLOW, {
      lookup: lookupReturning(ALLOW, [{ address: "127.0.0.1", family: 4 }]),
    });
    const res = await transport(
      request(`http://pinned.example:${receiver.port}/hook`),
      AbortSignal.timeout(3000),
    );
    expect(res.status).toBe(200);
    expect(res.responseBody).toBe("delivered");
    const got = await receiver.received;
    // The Host header reflects the original hostname, not the pinned IP.
    expect(got.headers.host).toBe(`pinned.example:${receiver.port}`);
  });
});
