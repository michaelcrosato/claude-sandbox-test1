# SPEC-WONTDO — Deliberate non-goals (do NOT implement)

- **Owner:** n/a (deferred) · **Status:** WONT-DO unless a human explicitly authorizes one
- Recorded so a future agent does not "discover" these as gaps. Detail + cost in [BACKLOG.md](../BACKLOG.md).

These are **not oversights** — they are scoped out by the `docs/GOAL.md` product boundary and/or the
operational wedge (single small process, no Redis/broker, true MIT). The 2026 research refresh
(Svix/Hookdeck/Standard Webhooks) re-confirmed each is incumbent scope, not a Posthorn requirement.

| Non-goal | Verdict | One-line rationale |
| --- | --- | --- |
| Asymmetric signatures (`v1a`/ed25519) | WONT-DO | HMAC-`v1` is spec-correct; asymmetric is demand-gated, new key-mgmt surface |
| Multi-destination sinks (SQS/S3/Kafka/…) | WONT-DO | That's Hookdeck Outpost's scope; breaks the no-broker wedge and product boundary |
| Full-text / payload search | WONT-DO | Needs a body index; contradicts "single small process" (already a documented non-goal in `docs/PARITY.md`) |
| FIFO / strict ordering | WONT-DO | Not a v1 contract; queue rework |
| mTLS / static egress IPs | WONT-DO | Deployment-specific enterprise networking |
| Additional SDK languages | WONT-DO | TS + Python cover the wedge buyer |
| Re-architect the SQLite single-writer default | WONT-DO | The ceiling **is** the wedge; Postgres HA path already exists |

## If a human authorizes one

It becomes a normal spec under this folder (description / ACs / approach / deps / test strategy /
effort / out-of-scope) and a `docs/GOAL.md` backlog entry — then it enters the loop like any other
bounded, validated change. Until then: **do not implement, do not scaffold, do not "prepare".**
