# SPEC-H2 — Docker image → registry (HUMAN-GATED)

- **Owner:** human (push) + agent (build/label verify only) · **Phase:** D · **Status:** not started
- **EXCLUSION:** pushing images to a registry is credential-gated.

## Description

The `Dockerfile` builds and carries OCI labels, and CI already builds + verifies the image. What
remains is **publishing** the image to a registry (GHCR/Docker Hub), which needs registry credentials.

## Acceptance criteria

- `docker build` succeeds and the image runs `posthorn` (already verified in CI).
- OCI labels (source, version, license) are present and correct (already verified).
- A documented push path (registry, tag scheme `:1.0.0` + `:latest`, who owns it) exists; the actual
  push is performed by the human with registry creds.

## Implementation approach

1. **Agent (no creds):** confirm the build + label-verify CI job is green; confirm the tag scheme is
   documented in `docs/DEPLOY.md`.
2. **Human:** authenticate to the registry; push the tags (optionally wire a release-triggered push
   job — a human-gated deployment change).

## Deps / prereqs

Registry account + credentials (human). Optionally the resolved name (SPEC-H5 Q1) for the image path.

## Test strategy

Local `docker build` + run smoke; CI image job; `docker pull` post-push (human).

## Out of scope

Registry credentials; the actual `docker push`; multi-arch/buildx matrix unless a human asks.
