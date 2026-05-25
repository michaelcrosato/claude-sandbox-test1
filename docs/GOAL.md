CURRENT_STATE: ACTIVE_SPECIFICATION

# Goal

Build **Posthorn**: reliable outbound webhook-delivery infrastructure for SaaS teams,
optimized for single-container self-hosting, Standard Webhooks compatibility, and
low-ops adoption by indie and SMB products.

The original open prompt was: "Find a software project to build." That decision is
resolved by `docs/PROJECT.md` and the current repository implementation. This file is
now the lifecycle gate and compact strategic brief for autonomous maintenance work.

## State Basis

- `docs/PROJECT.md` records Posthorn as **DECIDED** on 2026-05-22.
- The repository is no longer an empty discovery sandbox: it contains a TypeScript/Node
  product with durable stores, HTTP API, SDKs, dashboards, monitoring, deployment
  documentation, PostgreSQL optional backend, and broad local test coverage.
- No product-code work is authorized by this file directly; agents must still obey
  `docs/AXIOMS.md`, `docs/AGENT-LOOP.md`, `docs/LOG.md`, and the repository's local
  validation gates for each bounded change.

## Research Refresh - 2026-05-25

### GitHub owner check

Unauthenticated public repository inspection of `https://github.com/michaelcrosato`
on 2026-05-25 showed public repositories including `salesforce-lite-crm`,
`alpha-scale-engine5`, `alpha-scale-engine4`, `alpha-scale-engine3`, and
`agy-sandbox`. No public repository named Posthorn, webhook-delivery product, or
production deployment of this project was visible there.

Source:
https://github.com/michaelcrosato?tab=repositories

### Market signals

- **Svix** remains the premium incumbent: official pricing shows a free tier,
  Professional from USD 490/month, 50,000 included monthly messages, and USD 0.0001
  per additional message. Its enterprise tier includes on-prem options and advanced
  compliance/security features.
  Source: https://www.svix.com/pricing/
- **Hookdeck Outpost** has become the strongest open-source pressure on the wedge:
  Apache-2.0 self-hosted, managed pricing from USD 10 per million events, and broad
  event-destination support. Its README still lists infrastructure dependencies
  around Redis/Redis Cluster, PostgreSQL, and a supported message queue, leaving room
  for Posthorn's lower-ops single-process claim.
  Sources: https://hookdeck.com/outpost/pricing and https://github.com/hookdeck/outpost
- **Hook0** offers a free self-hosted option under SSPL-1.0 and cloud tiers starting
  at EUR 59/month for Startup, with visible daily event quotas and overage rates.
  Source: https://www.hook0.com/pricing
- **Convoy** remains a mature webhook gateway with broad ingress/egress scope,
  customer-facing dashboards, retries, circuit breaking, and a cloud Pro plan shown
  at USD 99/month. Its current public repository presents Elastic License v2.0 rather
  than the older MIT positioning recorded in early project notes.
  Sources: https://www.getconvoy.io/pricing and https://github.com/frain-dev/convoy
- **Standard Webhooks** continues to be a credible interoperability anchor for the
  category, explicitly framing webhooks around security, interoperability, and
  reliability.
  Source: https://www.standardwebhooks.com/

### Research conclusion

Posthorn remains a viable project only if it avoids generic "Svix clone" scope and
owns the narrow operational wedge:

1. SQLite-first single process by default.
2. No Redis or message broker required for the core deployment.
3. Standard Webhooks signing and verification as a first-class contract.
4. Embeddable Node library mode plus standalone gateway.
5. Simple self-host path first, with hosted/cloud monetization later.

Hookdeck Outpost materially raises the competitive bar for open-source outbound
webhooks. Future work should therefore prioritize release trust, operational
simplicity, contract stability, and hosted-billing readiness over broad destination
matrix expansion.

## System Blueprint

### Product boundary

Posthorn sends webhooks from a SaaS platform to that platform's customers. It is not a
general event bus, inbound webhook router, CRM, workflow engine, or multi-protocol
destination hub. Its v1 buyer is an engineering team that wants reliable outbound
webhooks without introducing Redis, a broker, or a separate operations surface.

### Architectural constraints

- Default deployment is one Node process with embedded SQLite persistence.
- PostgreSQL remains optional for active/active multi-replica deployments.
- Redis and external queue brokers remain outside the core path.
- Public contracts are HTTP API, OpenAPI, TypeScript SDK, CLI/admin surfaces,
  dashboards, environment variables, metrics, logs, and storage compatibility.
- Every product change must preserve tenant isolation, idempotent intake, durable
  at-least-once delivery, bounded shutdown behavior, SSRF protections, and documented
  validation.

### Execution posture

Because `CURRENT_STATE` is `ACTIVE_SPECIFICATION`, unattended agents may perform only
bounded maintenance unless a human gives a larger directive:

- lint fixes;
- formatting normalization;
- dead-code removal;
- comment/docstring cleanup;
- small localized bug fixes with an obvious validation path.

Do not change schemas, public interfaces, dependencies, storage formats, deployment
behavior, or core architecture during unattended maintenance. Larger opportunities go
to `docs/LOG.md` under `Decisions` or `Next`, not directly into code.

### Highest-leverage next themes

- Keep the log, OpenAPI, README, deployment guide, SDK types, and config documentation
  synchronized as the product stabilizes.
- Prioritize small reliability or contract-hardening fixes with deterministic local
  gates.
- Treat hosted billing, package publishing, public website, and cloud control-plane
  work as human-supervised strategy items, not unattended maintenance.

## Non-Blocking Discovery Questions

1. Should **Posthorn** remain the public product name, or should it be renamed before npm/package/repository publication?
2. Is the first commercial path a hosted cloud service, paid self-host support, or enterprise licensing?
3. Should the free/paid plan meter accepted messages, delivery attempts, active endpoints, or a blended unit?
4. Which deployment target must be polished first: Docker Compose, Kubernetes, npm library embedding, or managed cloud?
5. What is the minimum public-launch bar: npm package, Docker image, hosted demo, landing page, or all four together?
