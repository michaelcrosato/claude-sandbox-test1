# plan/RESEARCH — External context & opportunities (Phase 2, 2026-05-29)

Independent web research this session across the stack and domain. Conclusion up front: **no
migration risk and no new autonomous feature work is indicated** — the findings confirm Posthorn's
posture and add one actionable piece of guidance for the human-gated `npm publish`.

## Comparable products / open-source alternatives

| Product | License / model | Self-host deps | Notes (2026) |
| --- | --- | --- | --- |
| **Svix** | MIT server / SaaS | Postgres + Redis | Strongest true-OSS incumbent, but the self-host build is now positioned as a reduced-feature **emulator** "for dev/testing, not production." Pro from ~$490/mo. |
| **Hookdeck Outpost** | Apache-2.0 / SaaS | Redis + PG + MQ | True OSS; **9 event destinations** (HTTP, SQS, S3, GCP Pub/Sub, RabbitMQ, ServiceBus, EventBridge, Kafka, Hookdeck) — multi-destination scope. ~$100 / 10M events managed. |
| **Convoy** | Elastic License v2 | Postgres + Redis | Go; broad ingress/egress; not MIT. |
| **Hook0** | SSPL (managed-restricted) | PostgreSQL 15+ | Rust; cloud tiers from ~€59/mo. |

**Implication:** Posthorn's wedge is **intact and arguably reinforced** — true-MIT, single Node
process, **no Redis/broker**, embeddable as a library, and production-capable self-host. Multi-
destination sinks and full-text payload search are **deliberate non-goals** (incumbent scope that
would break the single-small-process promise), recorded in [specs/SPEC-WONTDO](specs/SPEC-WONTDO-non-goals.md).

## 2026 best practices vs. current posture

| Area | 2026 standard | Posthorn | Verdict |
| --- | --- | --- | --- |
| **Datastore (`node:sqlite`)** | Still **Stability 1.2 RC / experimental** as of Node v25.7.0 (Feb 2026); Node 24 LTS since Oct 2025 | `engines >=22.13`, RC status documented, Postgres = stable-API alternative | ✅ correct, no drift |
| **Webhook signing** | Standard Webhooks: `v1` symmetric (HMAC) / `v1a` asymmetric (EdDSA) | HMAC-`v1`, first-class | ✅ spec-correct; asymmetric is a human-gated non-goal |
| **SSRF** | Connect-time re-validation, allow-list, don't follow redirects (OWASP) | DNS-pin + connect-time guard, **3xx not followed** | ✅ matches guidance — redirect-rebinding class closed |
| **Observability** | App-prefixed metric names, **bounded label cardinality** | `/metrics` labels guarded as a closed set (OPP-10) | ✅ done |
| **CI/CD** | Multi-version matrix, machine-readable test output, image+dep audit | Node matrix, `test:json`, docker/helm/pack/audit jobs | ✅ comprehensive |
| **npm supply-chain** | **Trusted publishing (OIDC) + automatic provenance**, classic-token deprecation, FIDO 2FA, granular short-lived tokens | not yet published (EXCLUSION) | ⚠ **actionable guidance for the human publish step** |

## Known pitfalls / recent advisories

- **npm (May 2026):** a worm published malicious packages carrying **valid SLSA Build-Level-3
  provenance** — Sigstore correctly attested *which* workflow built them. Lesson: **provenance proves
  the pipeline, not that the pipeline's inputs were clean.** Mitigation for SPEC-H1: publish via CI
  trusted-publishing with provenance, review diff + lockfile before tagging, and lean on Posthorn's
  near-zero runtime deps (the strongest structural mitigation). See [RISK_REGISTER R8](RISK_REGISTER.md).
- **`node:sqlite` churn:** pre-stable API may change across Node lines; pinned floor + Postgres path
  contain this.

## Migration-risk flag

**None recommended.** Every gap surfaced (asymmetric signing, multi-destination, payload search, SDK
breadth) is incumbent scope that conflicts with Posthorn's product boundary, not a correctness or
security deficiency. Adopting any would be a human-authorized strategy change, not maintenance.

## Sources

- [SQLite | Node.js Documentation](https://nodejs.org/api/sqlite.html)
- [Standard Webhooks specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) · [Asymmetric key signatures — webhooks.fyi](https://webhooks.fyi/security/asymmetric-key-signatures)
- [Trusted publishing for npm | npm Docs](https://docs.npmjs.com/trusted-publishers/) · [Generating provenance statements | npm Docs](https://docs.npmjs.com/generating-provenance-statements/) · [npm Adds 2FA-Gated Publishing — The Hacker News](https://thehackernews.com/2026/05/npm-adds-2fa-gated-publishing-and.html) · [npm Supply Chain Security in 2026 — Mondoo](https://mondoo.com/blog/npm-supply-chain-security-package-manager-defenses-2026)
- [Best Open-Source Webhook Tools (2026) — Svix](https://www.svix.com/webhooks/best-open-source-webhook-tools/) · [Hookdeck Outpost vs Svix Dispatch (2026)](https://hookdeck.com/webhooks/platforms/hookdeck-outpost-vs-svix-dispatch-webhook-sending-comparison) · [Hook0 vs Svix vs Hookdeck (2026)](https://documentation.hook0.com/comparisons)
