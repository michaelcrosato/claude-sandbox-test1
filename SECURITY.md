## Security Policy

## Supported versions

Posthorn follows semantic versioning. Security fixes are provided for the latest `1.x`
release line.

| Version | Supported |
| ------- | --------- |
| 1.x     | Yes       |
| < 1.0   | No        |

## Reporting a vulnerability

Please report security vulnerabilities **privately** — do not open a public issue or
pull request.

- Preferred: use GitHub's private vulnerability reporting on this repository
  (the **Security** tab -> **Report a vulnerability**).
- Alternatively, email **michael.crosato@gmail.com** with the details.

Please include enough information to reproduce: affected version, configuration, a
proof-of-concept or reproduction steps, and the impact you observed. We aim to acknowledge
a report within a few business days and will coordinate a fix and disclosure timeline with
you. Please give us a reasonable opportunity to ship a fix before any public disclosure.

## Security posture

Posthorn is designed to be safe to expose to untrusted webhook destinations:

- **Minimal attack surface.** The core has zero required runtime dependencies — it runs on
  Node.js built-ins (`node:sqlite`, `node:crypto`, `node:http`). PostgreSQL support is an
  optional dependency used only for multi-replica deployments.
- **SSRF protection.** Outbound webhook URLs (and tenant system-webhook URLs) are validated
  against a guard that blocks private, loopback, link-local, and internal addresses. The
  guard closes IPv6-hex and NAT64 embedded-IPv4 bypasses and re-checks at connection time to
  defeat DNS-rebinding.
- **Signed payloads.** Deliveries are signed with HMAC per the Standard Webhooks
  specification; the SDK ships a constant-time verification helper for receivers.
- **Tenant isolation.** Apps/tenants are isolated by API-key authentication; the admin
  control-plane API is opt-in and token-gated.
- **Web hardening.** The dashboard and consumer portal escape user-reflected content,
  serve `no-store` cache-control on authenticated HTML, set defense-in-depth response headers,
  use CSP-safe confirmations, and support configurable HSTS (emitted only for HTTPS-identified
  requests).

## Operator responsibilities

- Set a strong `POSTHORN_ADMIN_TOKEN` and keep it secret; restrict network access to the
  admin/control-plane surface.
- Run behind TLS (terminate at a proxy or load balancer) and forward `X-Forwarded-Proto`.
- Keep your Node.js runtime and the Posthorn image up to date.
