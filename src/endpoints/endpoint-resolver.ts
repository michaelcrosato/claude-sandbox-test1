/**
 * The bridge between the {@link EndpointStore} and the delivery worker.
 *
 * The worker is deliberately ignorant of *where* an event goes: it claims a task,
 * loads its message, and asks an injected `EndpointResolver` to turn that task
 * into a {@link DeliveryTarget} (URL + signing secret). Until now there was no
 * resolver to inject — the endpoint had no home. {@link storeBackedResolver} is
 * that home: it looks the task's `endpointId` up in a store and adapts the stored
 * {@link Endpoint} into the worker's target shape.
 *
 * This is the seam the worker's docs called "the exact plug-point where P3's
 * endpoint store supplies each task's URL + signing secret."
 */

import type {
  DeliveryTarget,
  EndpointResolver,
} from "../worker/delivery-worker.js";
import type { Endpoint, EndpointStore } from "./endpoint.js";

/**
 * Adapt a stored {@link Endpoint} into the worker's {@link DeliveryTarget}. Pure.
 * v1 forwards only the URL and signing secret; per-endpoint custom headers are a
 * later add-on (the field already exists on the target).
 */
export function endpointToDeliveryTarget(endpoint: Endpoint): DeliveryTarget {
  return { url: endpoint.url, secret: endpoint.secret };
}

/**
 * Build an {@link EndpointResolver} backed by an {@link EndpointStore}.
 *
 * Resolution declines (returns `null`, which the worker records as a failed
 * attempt) in three cases, all of which the queue's retry/dead-letter policy then
 * handles — no out-of-band task cancellation is introduced here:
 *
 *  - the task carries no `endpointId` (nothing to resolve);
 *  - the endpoint no longer exists (e.g. it was deleted after enqueue);
 *  - the endpoint is `disabled` (administratively paused). Fan-out should not
 *    enqueue work for a disabled endpoint, but one disabled *after* enqueue is
 *    declined here so paused endpoints stop receiving deliveries.
 */
export function storeBackedResolver(store: EndpointStore): EndpointResolver {
  return async (task) => {
    if (task.endpointId === null) {
      return null;
    }
    const endpoint = await store.get(task.endpointId);
    if (endpoint === null || endpoint.disabled) {
      return null;
    }
    return endpointToDeliveryTarget(endpoint);
  };
}
