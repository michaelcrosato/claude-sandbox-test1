# SPEC-H1 — npm publish readiness (HUMAN-GATED; agent may prep only)

- **Owner:** human (publish) + agent (prep/dry-run only) · **Phase:** D · **Status:** OIDC `publish.yml` added (dormant); npm-side trusted-publisher activation pending (no npm auth in env — `ENEEDAUTH`)
- **EXCLUSION:** real `npm publish` is credential-gated — never run it autonomously.

## Description

The package is publish-shaped already (`version 1.0.0`, `bin`, `exports` with `types` before
`import`, `files` allowlist, an `npm pack` readiness test, `.d.ts` default-consumer smoke). What
remains is the **credentialed publish** and a 2026-correct publish pipeline.

## Acceptance criteria

- `npm pack --dry-run` ships `dist` entrypoints + `bin` + `.d.ts`, excludes tests/maps (already tested).
- A publish path using **trusted publishing (OIDC) from CI with automatic provenance** — no stored
  long-lived npm token — is documented (and, **only with human approval**, a `.github/workflows/
  publish.yml` is added; adding a deploy workflow is itself a human-gated deployment change).
- The published name is the resolved one from [SPEC-H5](SPEC-H5-resolve-discovery-questions.md) Q1.

## Implementation approach

1. **Agent (now, no creds):** confirm `npm pack --dry-run` contents; verify `exports`/`types`
   ordering; keep the `.d.ts` consumer smoke green. Draft (do not commit without approval) a
   `publish.yml` using `id-token: write` + npm trusted publishing; provenance is automatic from CI.
2. **Human:** configure the npm trusted publisher for the repo, FIDO 2FA, granular short-lived token
   if needed; tag a release; let CI publish with provenance.

## Deps / prereqs

Resolved package name (SPEC-H5 Q1). npm account + repo trusted-publisher config (human).

## Test strategy

`npm pack --dry-run`; the existing pack-readiness + `.d.ts` smoke tests; `npm view` post-publish (human).

## Out of scope

Running `npm publish`; creating npm credentials; renaming the package in code before Q1 is answered.

## Risk note (2026)

Provenance proves *which* pipeline built the tarball, **not** that the pipeline was clean — a
May-2026 worm shipped valid SLSA-L3 provenance. Review the diff + lockfile before tagging. Posthorn's
near-zero runtime deps is the strongest supply-chain mitigation. (See [RISK_REGISTER R8](../RISK_REGISTER.md).)
