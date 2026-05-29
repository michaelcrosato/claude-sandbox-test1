# Posthorn vs. Svix / Convoy / Hookdeck — parity matrix

A structured comparison of Posthorn against the three webhook-infrastructure products it
is most often weighed against. Its purpose is twofold: give an evaluator an honest feature
map, and drive Posthorn's own backlog — the [Codeable gaps](#codeable-gaps) section at the
end is the worklist that closes the genuine differences, one validated iteration each.

> **How to read this.** Posthorn cells are *code-verifiable* — each is backed by a route,
> module, or test in this repository, cited inline. Competitor cells reflect the vendors'
> **public positioning and documentation as of 2026-05** and are intentionally coarse
> (deployment model, licensing, broad capability classes) rather than fine-grained claims
> about another team's roadmap — products change, and this file does not try to track
> theirs. Treat competitor columns as orientation, not as a contractual statement about
> them. "✓" = supported, "partial" = supported with notable limits, "—" = not a
> first-class feature of that product's open/self-hosted offering, "n/a" = not applicable
> to that product's model.

## At a glance

|  | Svix | Convoy | Hookdeck | **Posthorn** |
| --- | --- | --- | --- | --- |
| License | source-available | MIT | proprietary (SaaS) | **MIT** |
| Delivery model | self-host or cloud | self-host or cloud | cloud-only | **self-host (single container)** |
| Self-host dependencies | Postgres + Redis | Postgres + Redis | n/a (cloud-only) | **none — SQLite built in** |
| Optional external DB | n/a | n/a | n/a | **Postgres (drop-in)** |
| Library / embeddable mode | partial | — | — | **✓ — embed in any Node app** |
| [Standard Webhooks](https://www.standardwebhooks.com/) signing | ✓ | partial | partial | **✓ first-class** |
| Entry price | $0 → $490/mo | $0 self-host / $99/mo cloud | usage-based SaaS | **$0, generous free tier** |
| Runtime footprint | service + Redis + PG | service + Redis + PG | n/a | **one Node process** |

The differentiator is the **operational wedge**: Posthorn delivers the reliability feature
set below with no Redis and no mandatory external database — a single container backed by
`node:sqlite`, with Postgres as an opt-in for horizontal scale. The reliability features
themselves are table stakes across mature gateways; the deployment model is not.

## Delivery & reliability

These are the core "did the webhook get there, safely and exactly enough times" features.
Most are expected of any serious gateway, so the interesting column is *where* Posthorn
implements each.

| Capability | Svix | Convoy | Hookdeck | **Posthorn** (where) |
| --- | --- | --- | --- | --- |
| Exponential backoff retries | ✓ | ✓ | ✓ | **✓** `src/delivery/retry-policy.ts` (8 attempts ≈ 28h, jittered) |
| At-least-once via durable queue | ✓ | ✓ | ✓ | **✓** leased store-backed queue, no Redis (`src/queue/`) |
| Dead-letter (terminal state) | ✓ | ✓ | ✓ | **✓** `src/delivery/delivery-state.ts` |
| Manual replay / retry | ✓ | ✓ | ✓ | **✓** `POST /v1/messages/:id/retry`, `POST /v1/endpoints/:id/replay` |
| Idempotent intake (producer dedup) | ✓ | partial | ✓ | **✓** per-app idempotency key + window (`src/storage/message-store.ts`) |
| Zero-downtime secret rotation | ✓ | partial | ✓ | **✓** multi-token overlap window (`POST /v1/endpoints/:id/rotate-secret`) |
| Auto-disable failing endpoints | ✓ | partial | ✓ | **✓** circuit-break after a failing window |
| SSRF / private-network guard | partial | — | n/a (cloud) | **✓** built-in, DNS-rebinding-safe (`src/net/ssrf-guard.ts`) |
| Scheduled delivery (`deliverAt`) | partial | — | ✓ | **✓** crash-safe `sendAt` |
| Message expiry (`expiresAt`) | — | — | partial | **✓** worker dead-letters past-expiry |
| Delivery priority | — | — | partial | **✓** `high`/`normal` claim ordering |
| Channels / subscription filtering | ✓ | ✓ | ✓ | **✓** per-endpoint event-type + channel filters |
| Per-endpoint rate limiting | ✓ | partial | ✓ | **✓** deliveries/minute, plan-defaulted |

## API & developer experience

| Capability | Svix | Convoy | Hookdeck | **Posthorn** (where) |
| --- | --- | --- | --- | --- |
| OpenAPI 3.1 contract | ✓ | ✓ | ✓ | **✓** `GET /openapi.json` (`src/http/openapi.ts`) |
| Static API reference + landing site | ✓ | ✓ | ✓ | **✓** `npm run build:site` (Redoc, offline) |
| Official SDKs | many | partial | several | **TypeScript + Python** (`src/sdk/`, `clients/python/`) |
| End-user CLI | ✓ | partial | ✓ | **✓** `posthorn client` (`src/runtime/client-cli.ts`) |
| Consumer portal (end-customer UI) | ✓ | partial | ✓ | **✓** `/portal/*` (`src/portal/`) |
| Event-type catalog | ✓ | partial | ✓ | **✓** CRUD `/v1/event-types` with per-type `schemaExample` |
| Per-attempt audit log | ✓ | ✓ | ✓ | **✓** `GET /v1/messages/:id/attempts` |
| Prometheus metrics | partial | partial | n/a (cloud) | **✓** `GET /metrics` (`src/metrics/`) |
| Admin / control-plane API | ✓ | ✓ | n/a | **✓** token-gated `/v1/admin/*` + `posthorn admin` CLI |
| Online backup / restore | managed | managed | managed | **✓** `posthorn admin backup`/`restore` (SQLite `VACUUM INTO`) |
| Self-serve signup seam | ✓ | — | ✓ | **✓** opt-in `POST /v1/signup` |
| Usage metering + quota enforcement | ✓ | partial | ✓ | **✓** per-tenant, monthly caps, `429` on breach |
| Message list filtering | by type, **time range, status** | by type, time range | **full-text + filters** | **✓ by `eventType`, `channel`, + `after`/`before` created-at window** (`src/http/api.ts`) |
| Catalog-driven test events | ✓ | partial | ✓ | **✓** `/v1/endpoints/:id/test` sends a registered event type's `schemaExample` (`payloadSource` reports the source) |
| Per-event-type payload examples in docs | ✓ | partial | ✓ | **partial — catalog has `schemaExample`, not surfaced in OpenAPI** (see gaps) |

## Codeable gaps

The matrix surfaced three places where Posthorn was genuinely behind and the gap was
*codeable in this repo* (as opposed to differences in hosting model or ecosystem size).
Each becomes one focused, gate-green iteration. Two are now closed; one remains:

1. ~~**Message list time-range filtering.**~~ **Closed.** `GET /v1/messages` now accepts a
   half-open `after`/`before` created-at window (`after` inclusive, `before` exclusive),
   composing with the existing `eventType`/`channel` filters and keyset pagination across
   all three store backends (`src/http/api.ts` `parseListMessagesParams`, the `listByApp`
   resolver + in-memory/SQLite/Postgres stores, the SDKs, and the OpenAPI contract).

2. ~~**Catalog-driven test events.**~~ **Closed.** `POST /v1/endpoints/:id/test` now draws
   its payload from the event-type catalog: when the caller supplies an `eventType` that is
   registered (and omits an explicit `payload`), the type's stored `schemaExample` is sent,
   turning the catalog into a living fixture set. A caller-supplied `payload` still wins, and
   an unknown type or one without an example falls back to the generic `{"test":true}`. The
   synchronous result now carries a `payloadSource` field (`request`/`catalog`/`default`) so
   the caller knows which path was taken (`src/http/api.ts`, the OpenAPI contract, the
   TypeScript + Python SDKs).

3. **Per-event-type examples in the OpenAPI document.** Event types and their
   `schemaExample`s are not reflected in `GET /openapi.json`, so generated clients and the
   Redoc site show only generic message schemas. Surfacing registered examples (or at least
   documenting the catalog as the source of per-type payloads) improves the developer
   experience parity. *Closes the "per-event-type payload examples" row.*

Free-text / payload search (Svix and Hookdeck offer it) is **deliberately deferred**: it
implies a full-text index over message bodies, which is a materially larger change than the
three above and is weighed against Posthorn's "single small process" promise. It is recorded
here as a known, intentional non-goal for v1.0 rather than an oversight.
