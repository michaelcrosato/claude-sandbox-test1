CURRENT_STATE: ACTIVE_SPECIFICATION

# Goal

Build **Posthorn**: reliable outbound webhook-delivery infrastructure for SaaS teams,
optimized for single-container self-hosting, Standard Webhooks compatibility, and
low-ops adoption by indie and SMB products.

The original open prompt was: "Find a software project to build." That decision is
resolved by `docs/PROJECT.md` and the current repository implementation. This file is
now the lifecycle gate and compact strategic brief for autonomous maintenance work.

## Active Human Directive — Commercial-Ready v1.0 (accepted 2026-05-28)

A human operator has issued a larger directive that supersedes the conservative
maintenance-only posture for the duration of this program: **take Posthorn to
commercial-ready v1.0**, keeping the name "Posthorn". Work the ordered backlog below;
each item is one or more bounded, validated loop iterations.

### Per-item definition of done (non-negotiable)

- `tsc -p tsconfig.json --noEmit` clean, `npx vitest run` green, `npm run build` succeeds.
- When a store changes, extend the shared dual-backend conformance suite.
- When an HTTP route changes, pass the bidirectional OpenAPI drift + orphan-schema tests.
- When a new `POSTHORN_*` var is added, document it in BOTH `.env.example` and `docs/DEPLOY.md`.
- Add a compiled-`dist` smoke for any new end-to-end path.
- Keep main green; never modify the hash-protected substrate files listed in
  `scripts/manifest.txt`; never hand-edit `docs/LOG.md`.

### Backlog (in order)

1. **v1.0 release engineering** — bump `0.0.1`→`1.0.0`; `CHANGELOG.md` (Keep a Changelog,
   reconstructed from git history); an `npm pack` readiness test asserting the tarball ships
   the dist entrypoints + bin + `.d.ts` and excludes tests; `CONTRIBUTING.md`, `SECURITY.md`
   (vuln disclosure + the zero-dep/SSRF posture), `CODE_OF_CONDUCT.md`, `.github` issue/PR templates.
2. **CI hardening** — add a `docker build` job, an `npm pack --dry-run` publish-readiness job,
   and a dependency/audit check to `ci.yml`; add OCI image labels to the Dockerfile.
3. **Plan catalog + entitlements** — generalize `App.monthlyMessageQuota` into a small Plan
   entity (free/pro/scale) carrying quota + retention + rate-limit entitlements, admin-settable
   via the existing `/v1/admin/apps` routes, enforced where quota already is.
4. **Billing behind flags (no live keys)** — `src/billing/` with a pluggable `BillingProvider`
   interface, a default `NoopBillingProvider`, and a `StripeBillingProvider` over an INJECTED
   transport tested against a mock; push metered usage from `summarizeUsageByApp` +
   `summarizeAttemptsByApp`; add a Stripe-signed `POST /v1/billing/webhook` verified with the
   same HMAC discipline as the signer.
5. **Self-serve signup seam** — an opt-in, disabled-by-default, rate-limited `POST /v1/signup`
   that creates an app + first key + assigns the free plan, hidden as 404 until enabled.
6. **Kubernetes** — a Helm chart at `deploy/helm/posthorn` (Deployment, Service, ConfigMap,
   Secret, PVC or PG via values, `/healthz` + `/readyz` probes, optional `/metrics` ServiceMonitor),
   validated by `helm lint` + `helm template` if present, else a template-render + schema test.
7. **Python SDK + CLI** — generate a typed Python client from the OpenAPI and round-trip it
   against a booted gateway; add an expanded end-user CLI (`posthorn send`/`endpoints`/`tail`)
   on the TS SDK.
8. **Static docs + landing site** — a Redoc HTML site from `GET /openapi.json` + a
   getting-started page, and a single-file landing page carrying the wedge/pricing table from
   the README, output under `site/` via a gate-clean build script.
9. **Throughput benchmark** — a `bench/` harness (in-process fake receiver) measuring ingest
   and delivery ops/sec over a bounded run; write `BENCHMARKS.md`, assert non-flaky in the gate.
10. **Backup/restore** — a `posthorn admin backup`/`restore` subcommand using SQLite's online
    backup API (and a documented `pg_dump` path), with a backup→restore test; add a DEPLOY.md runbook.
11. **Final incumbent-parity sweep** — a structured feature matrix vs Svix/Convoy/Hookdeck,
    then close any genuinely codeable gaps found, one validated iteration each.

### Exclusions (log to the iteration's `Next`/`Decisions`; never attempt — credential-gated, not codeable)

Real `npm publish`, pushing Docker images to a registry, a live Stripe account + live API keys,
purchasing a domain, deploying a hosted/cloud demo, trademark registration. Build / lint /
dry-run / mock-validate everything; leave the credential-gated final push to the human.

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

`CURRENT_STATE` remains `ACTIVE_SPECIFICATION` so the substrate keeps looping, but a human
has now given the larger directive recorded above (**Active Human Directive — Commercial-Ready
v1.0**). That directive authorizes the backlog's product-code work — new modules, a Plan
entity, billing, a signup route, deployment artifacts — as bounded, validated iterations, each
held to the per-item definition of done.

Outside that backlog, the conservative defaults still hold. Bounded maintenance remains always
in scope:

- lint fixes;
- formatting normalization;
- dead-code removal;
- comment/docstring cleanup;
- small localized bug fixes with an obvious validation path.

Do not change schemas, public interfaces, dependencies, storage formats, deployment behavior,
or core architecture except where an explicit backlog item requires it. Anything beyond the
backlog or the bounded-maintenance set is a human-supervised decision — record it under
`Decisions`/`Next`, do not free-style it into code.

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

## Discovery Decisions — delegated to the agent (2026-05-29)

A human operator delegated these five decisions to the agent ("make those decisions, document it,
and proceed"). They are decided below, aligned with the strategic brief above; **all are reversible** —
a human can override any by editing this section.

1. **Public name → keep "Posthorn".** Established across the code, package, docs, and image labels;
   the 2026-05-25 owner check found no conflicting public repo. Renaming now is pure churn. (A formal
   trademark search/registration remains a separate human/legal step — not a code action.)
2. **First commercial path → open-core self-host now, hosted-cloud tier later.** The MIT core stays
   free and self-hostable (the wedge); monetize via a hosted/managed tier and paid support once there
   is demand. Matches "simple self-host path first, hosted/cloud monetization later."
3. **Metering unit → accepted messages (per-tenant, monthly).** Already implemented
   (`monthlyMessageQuota`, `429` on breach); simplest unit to explain and bill; mirrors the incumbent
   per-message model. Delivery attempts/active endpoints stay observable but are not the billed unit.
4. **First deploy target to polish → Docker (single container).** The headline artifact and the
   operational wedge; Helm and library-embedding remain supported secondary paths.
5. **Minimum public-launch bar → npm package + Docker image + landing page.** All three are already
   buildable and gate-clean (`npm pack`, `docker build`, `npm run build:site`). A hosted live demo is
   deferred (ongoing infra cost/ops) and can follow launch.

These decisions unblock the *codeable* parts of launch (e.g. the OIDC publish workflow at
`.github/workflows/publish.yml`). The remaining steps are **credential-gated and cannot be performed
without real accounts/tokens/payment** — verified absent in the build environment on 2026-05-29 (npm
`ENEEDAUTH`; no registry login; `STRIPE_*`/`NPM_TOKEN`/`DOCKER_*` unset): publishing to npm, pushing
the image to a registry, enabling live Stripe, buying a domain, and trademark registration. See
`plan/specs/SPEC-H1…H4`.
