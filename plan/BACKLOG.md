# plan/BACKLOG — future / human-gated ideas only

**Nothing here is authorized for autonomous work.** This is a holding pen for ideas that are out of
the harden-only lane and/or out of the [`docs/GOAL.md`](../docs/GOAL.md) product boundary. Each needs
an explicit human decision (and most would dent the operational wedge). Mirrors the "Do Not Do Now"
list in [`.agent/master_plan.md`](../.agent/master_plan.md), refreshed with 2026 research.

## Deferred product features (each = a deliberate non-goal today)

| Idea | Why deferred | What it would cost |
| --- | --- | --- |
| **Asymmetric signatures** (`v1a` / EdDSA·ed25519 per Standard Webhooks) | Real incumbent feature (Svix); Posthorn is HMAC-`v1` only | New key-management surface + SDK + verifier; only worth it on customer demand |
| **Multi-destination sinks** (SQS/S3/Kafka/PubSub/…) | This is Hookdeck Outpost's scope (9 destinations); explicitly outside Posthorn's "outbound webhooks" boundary | A connector framework + brokers — directly contradicts the no-Redis/single-process wedge |
| **Full-text / payload search** | Svix & Hookdeck offer it; implies a full-text index over message bodies | A search index — materially larger than the single small process promises (already recorded as an intentional non-goal in `docs/PARITY.md`) |
| **FIFO / strictly-ordered delivery** | Not a v1 contract | Per-key ordering + queue rework |
| **mTLS / static egress IPs** | Enterprise networking ask | Egress proxy / cert plumbing; deployment-specific |
| **More SDK languages** (Go/Ruby/Java/…) | TS + Python cover the wedge buyer | Per-language client + CI + release pipeline each |
| **"Fix" the SQLite single-writer ceiling** | **The ceiling IS the wedge** | Postgres HA path already exists for scale; do not re-architect the default |

## Credential-gated launch (the `docs/GOAL.md` EXCLUSIONS — see [specs/SPEC-H1…H4](specs/))

Real `npm publish` · pushing Docker images to a registry · a live Stripe account + live keys ·
purchasing a domain · a hosted/cloud demo · trademark registration. **Build / dry-run / mock only**
in the agent lane; the credentialed push is the human's.

## Open strategy (the 5 discovery questions — see [specs/SPEC-H5](specs/SPEC-H5-resolve-discovery-questions.md))

Public name · first commercial path · metering unit · first deploy target to polish · minimum
public-launch bar. These are human decisions and **must not be answered in code**.
