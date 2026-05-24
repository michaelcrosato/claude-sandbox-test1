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
import { activeSigningSecrets, type Endpoint, type EndpointStore } from "./endpoint.js";

/**
 * Adapt a stored {@link Endpoint} into the worker's {@link DeliveryTarget} as of
 * `nowMs`. Pure. The primary `secret` signs the delivery; any secrets still inside
 * their rotation overlap window (see {@link activeSigningSecrets}) are forwarded as
 * `additionalSecrets`, so during a rotation the payload carries one signature token
 * per active secret and a receiver that has not yet switched still verifies. The
 * `additionalSecrets` field is omitted entirely when there is no active overlap.
 * Custom headers (see {@link Endpoint.headers}) are forwarded as-is; the worker
 * merges them before the Standard Webhooks signing headers, so the signatures
 * always win and cannot be overridden.
 */
export function endpointToDeliveryTarget(
  endpoint: Endpoint,
  nowMs: number,
): DeliveryTarget {
  // activeSigningSecrets returns [primary, ...still-active retirees]; the primary
  // is `secret`, the rest (if any) are the rotation-overlap extras.
  const additionalSecrets = activeSigningSecrets(endpoint, nowMs).slice(1);
  return {
    url: endpoint.url,
    secret: endpoint.secret,
    ...(additionalSecrets.length > 0 ? { additionalSecrets } : {}),
    ...(endpoint.headers ? { headers: endpoint.headers } : {}),
  };
}

/** Options for {@link storeBackedResolver}. */
export interface StoreBackedResolverOptions {
  /**
   * Clock returning epoch ms, used to decide which rotation-overlap secrets are
   * still active at resolution (≈ send) time. Defaults to {@link Date.now};
   * inject a fake clock in tests.
   */
  readonly now?: () => number;
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
export function storeBackedResolver(
  store: EndpointStore,
  options: StoreBackedResolverOptions = {},
): EndpointResolver {
  const now = options.now ?? Date.now;
  return async (task) => {
    if (task.endpointId === null) {
      return null;
    }
    const endpoint = await store.get(task.endpointId);
    if (endpoint === null || endpoint.disabled) {
      return null;
    }
    return endpointToDeliveryTarget(endpoint, now());
  };
}
