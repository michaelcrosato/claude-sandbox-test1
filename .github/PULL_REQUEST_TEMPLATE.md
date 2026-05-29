## Summary

What does this change do, and why?

## Changes

- ...

## Validation gate

All three must be green (see CONTRIBUTING.md):

- [ ] `npx tsc -p tsconfig.json --noEmit` passes
- [ ] `npx vitest run` passes
- [ ] `npm run build` succeeds

## Checklist

- [ ] Storage change? Extended the shared dual-backend conformance suite.
- [ ] HTTP route change? OpenAPI spec updated; drift + orphan-schema tests pass.
- [ ] New end-to-end path? Added a compiled-`dist` smoke.
- [ ] New `POSTHORN_*` var? Documented in both `.env.example` and `docs/DEPLOY.md`.
- [ ] Commits follow Conventional Commits.
- [ ] Did not modify automation-managed control-plane files (see `scripts/manifest.txt`) or `docs/LOG.md`.
