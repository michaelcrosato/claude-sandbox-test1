# SPEC-H4 — Hosted demo + domain + trademark (HUMAN-GATED)

- **Owner:** human · **Phase:** D · **Status:** not started
- **EXCLUSION:** buying a domain, deploying a hosted demo, trademark registration — all
  credential-/cost-/legal-gated and entirely human.

## Description

A public-facing demo and brand assets. The artifacts that *feed* this are built and gate-clean: the
static docs + landing site (`npm run build:site` → `site/`, Redoc + getting-started), the Helm chart
(`deploy/helm/posthorn`), and `Dockerfile`/`docker-compose.yml`. What remains is **standing up real
infrastructure and acquiring a name**, which the agent cannot and must not do.

## Acceptance criteria

- `npm run build:site` produces a deployable `site/` (already gate-clean).
- Helm `lint`/`template` (or the template-render test) pass (already in CI).
- A human deploys the demo to chosen infra under a chosen domain; trademark handled by the human.

## Implementation approach

1. **Agent:** keep the site build + Helm render green; keep deployment docs (`docs/DEPLOY.md`,
   multi-replica topology) accurate.
2. **Human:** buy the domain (after SPEC-H5 Q1), deploy (Compose/K8s per SPEC-H5 Q4), configure TLS,
   handle trademark.

## Deps / prereqs

Resolved name (SPEC-H5 Q1), first deploy target (SPEC-H5 Q4), cloud account + domain + budget (human).

## Test strategy

Site build + Helm render in CI; a human smoke of the live demo.

## Out of scope

Any cloud/DNS/registrar/legal action; provisioning infrastructure; spending money.
