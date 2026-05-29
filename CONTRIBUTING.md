## Contributing to Posthorn

Thanks for your interest in Posthorn. This guide covers local setup, the validation
gate every change must pass, and the architectural conventions that keep the codebase
honest.

## Project shape

- TypeScript on Node.js (`>=20`), ES modules.
- **Zero required runtime dependencies** — the core runs on Node built-ins (`node:sqlite`,
  `node:crypto`, `node:http`). PostgreSQL (`pg`) is an *optional* dependency for
  multi-replica deployments only.
- Default deployment is a single process with embedded SQLite. No Redis, no broker.

## Setup

```bash
npm install        # installs dev tooling (TypeScript, Vitest); pg is optional
npm run build      # tsc -> dist/
npm test           # vitest
```

## The validation gate

Every change must leave all three of these green before it is committed:

```bash
npx tsc -p tsconfig.json --noEmit   # types
npx vitest run                      # tests
npm run build                       # compile
```

Pull requests that do not pass the gate will not be merged. Do not weaken, skip, or work
around tests to make the gate pass.

## Architectural conventions

These are load-bearing — match them rather than introducing a parallel style:

- **Pure core, thin I/O.** Decision logic is pure and unit-tested; I/O lives at the edges
  behind injected seams (transport, clock, resolver). Inject dependencies; don't reach for globals.
- **One conformance suite per store.** Every storage backend (in-memory, SQLite, Postgres)
  is held to the *same* shared conformance suite. If you change a store interface, extend the
  shared suite — don't fork per-backend tests.
- **The OpenAPI contract is guarded.** `GET /openapi.json` is checked by a bidirectional
  drift test and an orphan-schema test. If you add or change an HTTP route, update the spec
  and keep both tests green.
- **New end-to-end paths get a compiled-`dist` smoke.** Runtime behavior is verified against
  the built output, not just the source.
- **New config is documented in two places.** A new `POSTHORN_*` environment variable must be
  added to both `.env.example` and `docs/DEPLOY.md` (a drift test enforces this).
- **Security is not optional.** Outbound URLs go through the SSRF guard; user-reflected HTML is
  escaped; authenticated HTML is `no-store`. Preserve tenant isolation and idempotent intake.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`,
  `chore:`, `refactor:`, `test:`, optionally scoped (e.g. `feat(security): ...`).
- Keep each change bounded and independently reviewable.
- Fill out the pull-request template, including the validation-gate checklist.

## Repository automation

This repository is also driven by an autonomous maintenance loop. A small set of
control-plane files (listed in `scripts/manifest.txt`, plus `docs/LOG.md`) are managed by
that automation and integrity-checked — **do not edit them by hand**. Everything under
`src/`, `docs/` (except the ledger), `deploy/`, and the test suites is normal contributable code.

## Security issues

Please do **not** open public issues for security vulnerabilities. See
[SECURITY.md](./SECURITY.md) for private disclosure instructions.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT License](./LICENSE).
