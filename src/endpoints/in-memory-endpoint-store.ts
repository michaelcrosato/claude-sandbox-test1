/**
 * An in-memory {@link EndpointStore}.
 *
 * The reference backend: zero dependencies, the behavioural specification the
 * durable backends must match. Ideal for embedding Posthorn in a single process
 * where durability across restarts is not required, and for tests.
 *
 * Endpoints are held in an insertion-ordered map as immutable snapshots — each
 * mutation replaces the entry with a fresh {@link Endpoint}, so a snapshot a
 * caller already holds never changes underneath them. Insertion order is the
 * {@link listByApp} order (oldest-first), matching the SQLite backend's `rowid`
 * order.
 *
 * Determinism is preserved by injecting the clock, id generator, and secret
 * generator, mirroring the rest of the core.
 */

import { generateSecret } from "../signing/webhook-signature.js";
import {
  applyEndpointUpdate,
  createEndpointId,
  normalizeNewEndpoint,
  UnknownEndpointError,
  type Endpoint,
  type EndpointStore,
  type EndpointUpdate,
  type NewEndpoint,
} from "./endpoint.js";

/** Construction options for {@link InMemoryEndpointStore}. */
export interface InMemoryEndpointStoreOptions {
  /** Clock returning epoch ms. Defaults to {@link Date.now}. */
  now?: () => number;
  /** Endpoint-id generator. Defaults to {@link createEndpointId}. */
  generateId?: () => string;
  /** Signing-secret generator for created endpoints. Defaults to {@link generateSecret}. */
  generateSecret?: () => string;
}

export class InMemoryEndpointStore implements EndpointStore {
  readonly #now: () => number;
  readonly #generateId: () => string;
  readonly #generateSecret: () => string;
  /** id → immutable endpoint snapshot. Insertion order is preserved. */
  readonly #endpoints = new Map<string, Endpoint>();

  constructor(options: InMemoryEndpointStoreOptions = {}) {
    const {
      now = Date.now,
      generateId = createEndpointId,
      generateSecret: makeSecret = generateSecret,
    } = options;
    this.#now = now;
    this.#generateId = generateId;
    this.#generateSecret = makeSecret;
  }

  /** Number of endpoints currently held. Convenience for inspection/tests. */
  get size(): number {
    return this.#endpoints.size;
  }

  async create(input: NewEndpoint): Promise<Endpoint> {
    const normalized = normalizeNewEndpoint(input);
    const nowMs = this.#now();
    const id = this.#generateId();
    if (this.#endpoints.has(id)) {
      throw new Error(`generated endpoint id "${id}" collides with an existing one`);
    }
    const endpoint: Endpoint = {
      id,
      appId: normalized.appId,
      url: normalized.url,
      secret: normalized.secret ?? this.#generateSecret(),
      description: normalized.description,
      eventTypes: normalized.eventTypes,
      disabled: normalized.disabled,
      createdAt: nowMs,
      updatedAt: nowMs,
    };
    this.#endpoints.set(id, endpoint);
    return endpoint;
  }

  async get(id: string): Promise<Endpoint | null> {
    return this.#endpoints.get(id) ?? null;
  }

  async listByApp(appId: string): Promise<readonly Endpoint[]> {
    const out: Endpoint[] = [];
    // Map iteration is insertion order → oldest-first.
    for (const endpoint of this.#endpoints.values()) {
      if (endpoint.appId === appId) out.push(endpoint);
    }
    return out;
  }

  async update(id: string, patch: EndpointUpdate): Promise<Endpoint> {
    const current = this.#endpoints.get(id);
    if (current === undefined) {
      throw new UnknownEndpointError(id);
    }
    const next = applyEndpointUpdate(current, patch, this.#now());
    this.#endpoints.set(id, next); // same key → keeps insertion order
    return next;
  }

  async delete(id: string): Promise<boolean> {
    return this.#endpoints.delete(id);
  }
}
