import { describe, expect, it } from "vitest";
import {
  endpointToDeliveryTarget,
  storeBackedResolver,
} from "./endpoint-resolver.js";
import { InMemoryEndpointStore } from "./in-memory-endpoint-store.js";
import { InMemoryMessageStore } from "../storage/in-memory-store.js";
import { InMemoryDeliveryQueue } from "../queue/in-memory-queue.js";
import { type DeliveryTask } from "../queue/delivery-queue.js";
import {
  DeliveryWorker,
  type HttpDeliveryRequest,
  type Transport,
} from "../worker/delivery-worker.js";
import { HEADERS, verify } from "../signing/webhook-signature.js";

/** Minimal stub task carrying just the field the resolver reads. */
function taskWithEndpoint(endpointId: string | null): DeliveryTask {
  return {
    id: "dtask_1",
    messageId: "msg_1",
    endpointId,
    appId: null,
    status: "delivering",
    attempts: 1,
    nextAttemptAt: null,
    leaseExpiresAt: 1,
    leaseToken: "tok",
    lastError: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

const FAKE_MESSAGE = {
  id: "msg_1",
  appId: "app_1",
  idempotencyKey: null,
  eventType: "user.created",
  payload: "{}",
  createdAt: 0,
} as const;

describe("endpointToDeliveryTarget", () => {
  it("forwards the url and secret (no overlap → no additionalSecrets)", () => {
    const target = endpointToDeliveryTarget(
      {
        id: "ep_1",
        appId: "app_1",
        url: "https://x.test/hook",
        secret: "whsec_abc",
        previousSecrets: [],
        description: "",
        eventTypes: null,
        disabled: false,
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureAt: null,
        createdAt: 0,
        updatedAt: 0,
      },
      1_000,
    );
    expect(target).toEqual({ url: "https://x.test/hook", secret: "whsec_abc" });
  });

  it("forwards still-active rotation secrets, dropping expired ones", () => {
    const target = endpointToDeliveryTarget(
      {
        id: "ep_1",
        appId: "app_1",
        url: "https://x.test/hook",
        secret: "whsec_new",
        previousSecrets: [
          { secret: "whsec_active", expiresAt: 2_000 },
          { secret: "whsec_expired", expiresAt: 500 },
        ],
        description: "",
        eventTypes: null,
        disabled: false,
        consecutiveFailures: 0,
        firstFailureAt: null,
        lastFailureAt: null,
        createdAt: 0,
        updatedAt: 0,
      },
      1_000,
    );
    expect(target).toEqual({
      url: "https://x.test/hook",
      secret: "whsec_new",
      additionalSecrets: ["whsec_active"],
    });
  });
});

describe("storeBackedResolver", () => {
  it("resolves a live endpoint to its target", async () => {
    const store = new InMemoryEndpointStore();
    const ep = await store.create({
      appId: "app_1",
      url: "https://x.test/hook",
      secret: "whsec_abc",
    });
    const resolver = storeBackedResolver(store);
    expect(await resolver(taskWithEndpoint(ep.id), FAKE_MESSAGE)).toEqual({
      url: "https://x.test/hook",
      secret: "whsec_abc",
    });
  });

  it("declines a task with no endpointId", async () => {
    const resolver = storeBackedResolver(new InMemoryEndpointStore());
    expect(await resolver(taskWithEndpoint(null), FAKE_MESSAGE)).toBeNull();
  });

  it("declines an unknown endpoint (e.g. deleted after enqueue)", async () => {
    const resolver = storeBackedResolver(new InMemoryEndpointStore());
    expect(await resolver(taskWithEndpoint("ep_gone"), FAKE_MESSAGE)).toBeNull();
  });

  it("declines a disabled endpoint", async () => {
    const store = new InMemoryEndpointStore();
    const ep = await store.create({
      appId: "app_1",
      url: "https://x.test/hook",
      disabled: true,
    });
    const resolver = storeBackedResolver(store);
    expect(await resolver(taskWithEndpoint(ep.id), FAKE_MESSAGE)).toBeNull();
  });

  it("forwards a rotation-overlap secret as additionalSecrets, honoring its clock", async () => {
    let nowMs = 1_000;
    const store = new InMemoryEndpointStore({ now: () => nowMs });
    const ep = await store.create({
      appId: "app_1",
      url: "https://x.test/hook",
      secret: "whsec_v1",
    });
    await store.rotateSecret(ep.id, { secret: "whsec_v2", overlapMs: 10_000 });
    const resolver = storeBackedResolver(store, { now: () => nowMs });

    // During the overlap, the retired secret rides along as additionalSecrets.
    expect(await resolver(taskWithEndpoint(ep.id), FAKE_MESSAGE)).toEqual({
      url: "https://x.test/hook",
      secret: "whsec_v2",
      additionalSecrets: ["whsec_v1"],
    });

    // Past the overlap, only the new primary is forwarded.
    nowMs = 1_000 + 10_000 + 1;
    expect(await resolver(taskWithEndpoint(ep.id), FAKE_MESSAGE)).toEqual({
      url: "https://x.test/hook",
      secret: "whsec_v2",
    });
  });
});

describe("end-to-end: worker delivers to a stored endpoint", () => {
  it("signs against the stored secret so the request verifies", async () => {
    const nowMs = 1_700_000_000_000;
    const now = (): number => nowMs;

    // The full pipeline, all in-memory, sharing one clock.
    const endpoints = new InMemoryEndpointStore({ now });
    const store = new InMemoryMessageStore({ now });
    const queue = new InMemoryDeliveryQueue({ now });

    // A real endpoint with a server-generated secret, and a message to deliver.
    const endpoint = await endpoints.create({
      appId: "app_1",
      url: "https://example.test/hook",
    });
    const { message } = await store.create({
      appId: "app_1",
      eventType: "user.created",
      payload: '{"hello":"world"}',
    });
    // Fan-out (next tick) will do this; here we enqueue the (message, endpoint) pair.
    await queue.enqueue({ messageId: message.id, endpointId: endpoint.id });

    // Capture the emitted request instead of hitting the network.
    let captured: HttpDeliveryRequest | null = null;
    const transport: Transport = async (request) => {
      captured = request;
      return { status: 200 };
    };

    const worker = new DeliveryWorker({
      queue,
      store,
      resolveEndpoint: storeBackedResolver(endpoints),
      transport,
      now,
    });

    const result = await worker.processOnce();
    expect(result).toMatchObject({ claimed: 1, succeeded: 1 });

    // The worker resolved the endpoint, signed with its secret, and POSTed it.
    expect(captured).not.toBeNull();
    const request = captured as unknown as HttpDeliveryRequest;
    expect(request.url).toBe("https://example.test/hook");
    expect(request.body).toBe('{"hello":"world"}');

    // The headline guarantee: the emitted signature verifies against the secret
    // the store minted — the full create → enqueue → resolve → sign → deliver
    // loop closes against the real verifier.
    expect(() =>
      verify(
        endpoint.secret,
        {
          id: request.headers[HEADERS.id]!,
          timestamp: request.headers[HEADERS.timestamp]!,
          signature: request.headers[HEADERS.signature]!,
        },
        request.body,
        { now: Math.floor(nowMs / 1000) },
      ),
    ).not.toThrow();
  });
});
