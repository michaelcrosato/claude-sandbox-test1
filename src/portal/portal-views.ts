/**
 * Pure HTML string builders for the consumer app portal.
 *
 * The portal is the embeddable, customer-facing face of Posthorn: a SaaS tenant
 * mints a time-limited portal session for one of their customers, who is then
 * redirected here to manage their own webhook endpoints (create, edit, delete,
 * view delivery status) without ever seeing the tenant's API key.
 *
 * All user-supplied strings pass through {@link esc} before insertion so the
 * views are XSS-safe regardless of content. Styles are inlined; zero external
 * assets — the same posture as the admin and tenant dashboards. The UI is
 * intentionally neutral (no Posthorn branding in the main chrome) so a SaaS
 * can embed it in an iframe without it looking out of place.
 */

import type { Endpoint } from "../endpoints/endpoint.js";
import type { DeliveryTask } from "../queue/delivery-queue.js";
import type { EventType } from "../event-types/event-type.js";

/** Escape HTML entities to prevent XSS. */
export function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CSS = `
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#f8fafc;color:#0f172a;font-size:14px;line-height:1.5}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
header{background:#fff;border-bottom:1px solid #e2e8f0;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
header .brand{font-size:14px;font-weight:600;color:#334155}
.wrap{max-width:900px;margin:0 auto;padding:24px 20px}
h2{font-size:15px;font-weight:600;margin-bottom:14px;color:#0f172a}
.card{background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:18px;margin-bottom:16px}
.alert{padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:13px}
.alert-err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
.alert-ok{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}
.banner{background:#eff6ff;border:1px solid #bfdbfe;border-radius:8px;padding:14px;margin-bottom:16px}
.banner label{display:block;font-size:11px;font-weight:700;color:#1d4ed8;text-transform:uppercase;letter-spacing:.05em;margin-bottom:4px}
.banner .secret-val{font-family:ui-monospace,SFMono-Regular,monospace;font-size:13px;color:#1e40af;word-break:break-all;background:#dbeafe;padding:6px 10px;border-radius:4px;margin-top:4px}
.banner p{font-size:12px;color:#2563eb;margin-top:6px}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f1f5f9;font-size:13px;vertical-align:middle}
th{background:#f8fafc;font-weight:600;color:#64748b;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e2e8f0}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f8fafc}
.btn{display:inline-flex;align-items:center;padding:6px 14px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;line-height:1}
.btn:hover{text-decoration:none;filter:brightness(.93)}
.btn-blue{background:#2563eb;color:#fff}
.btn-gray{background:#e2e8f0;color:#374151}
.btn-red{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
.btn-sm{padding:4px 8px;font-size:12px}
input[type=text],input[type=url],input[type=number],textarea{padding:7px 10px;border:1px solid #cbd5e1;border-radius:6px;font-size:13px;outline:none;width:100%}
input:focus,textarea:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
label{display:block;font-size:12px;font-weight:600;margin-bottom:3px;color:#374151;text-transform:uppercase;letter-spacing:.04em}
.form-row{margin-bottom:14px}
.pill{display:inline-block;padding:2px 7px;border-radius:9999px;font-size:11px;font-weight:600}
.pill-green{background:#dcfce7;color:#15803d}
.pill-yellow{background:#fef9c3;color:#92400e}
.pill-red{background:#fee2e2;color:#b91c1c}
.pill-gray{background:#f1f5f9;color:#64748b}
.pill-blue{background:#dbeafe;color:#1d4ed8}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
.meta{color:#64748b;font-size:12px}
.empty{color:#64748b;font-size:13px;font-style:italic;padding:10px 0}
.trunc{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.section-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
/* login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc}
.login-box{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:32px;width:400px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
.login-box .heading{font-size:18px;font-weight:700;text-align:center;margin-bottom:4px;color:#0f172a}
.login-box .sub{color:#64748b;font-size:13px;text-align:center;margin-bottom:22px}
`;

function statusPill(status: string): string {
  const map: Record<string, string> = {
    succeeded: "pill-green",
    pending: "pill-blue",
    delivering: "pill-yellow",
    dead_letter: "pill-red",
  };
  const cls = map[status] ?? "pill-gray";
  return `<span class="pill ${cls}">${esc(status.replace("_", " "))}</span>`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function base(title: string, body: string, backLink = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Webhooks</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;gap:16px">
    <div class="brand">Webhooks</div>
    <nav style="display:flex;gap:12px">
      <a href="/portal/endpoints" style="color:#64748b;font-size:13px;font-weight:500">Endpoints</a>
      <a href="/portal/event-types" style="color:#64748b;font-size:13px;font-weight:500">Event Types</a>
    </nav>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    ${backLink}
    <form method="POST" action="/portal/logout" style="display:inline">
      <button type="submit" class="btn btn-gray btn-sm">Sign out</button>
    </form>
  </div>
</header>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

/** "Access denied / link expired" page — shown at GET /portal/login with no valid token. */
export function portalExpiredPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link expired — Webhooks</title>
<style>${CSS}</style>
</head>
<body>
<div class="login-wrap">
  <div class="login-box">
    <div class="heading">Link expired</div>
    <div class="sub" style="margin-top:8px">This portal link has expired or is invalid.<br>
    Please contact support for a new link.</div>
  </div>
</div>
</body>
</html>`;
}

/** Endpoints list page. `createdSecret` is set right after endpoint creation (one-time display). */
export function portalEndpointsPage(
  endpoints: readonly Endpoint[],
  createdSecret?: string,
  catalogTypes?: readonly { id: string; name: string }[],
  errorMessage?: string,
): string {
  // Escaped inline error (e.g. a rejected URL). Rendered as HTML text — never as a
  // script — so a hostile URL echoed back by validation cannot execute. See the
  // create handler, which previously injected this via an inline <script>alert(...)>.
  const errorBanner = errorMessage
    ? `<div class="alert alert-err">${esc(errorMessage)}</div>`
    : "";

  const secretBanner = createdSecret
    ? `<div class="banner">
  <label>Signing secret (shown once — copy it now)</label>
  <div class="secret-val">${esc(createdSecret)}</div>
  <p>Store this in your server's environment. After leaving this page it cannot be retrieved.<br>
  Use the <b>Rotate secret</b> button on an endpoint if you need a new one.</p>
</div>`
    : "";

  const rows =
    endpoints.length === 0
      ? `<tr><td colspan="4" class="empty">No endpoints yet. Create one below.</td></tr>`
      : endpoints
          .map((ep) => {
            const types =
              ep.eventTypes === null
                ? '<span class="pill pill-gray">All events</span>'
                : ep.eventTypes.length === 0
                  ? '<span class="meta">—</span>'
                  : ep.eventTypes.map((t) => `<span class="pill pill-gray">${esc(t)}</span>`).join(" ");
            const status = ep.disabled
              ? '<span class="pill pill-gray">disabled</span>'
              : '<span class="pill pill-green">active</span>';
            return `<tr>
  <td class="trunc"><a href="/portal/endpoints/${esc(ep.id)}" title="${esc(ep.url)}">${esc(ep.url)}</a></td>
  <td style="max-width:180px">${types}</td>
  <td>${status}</td>
  <td class="meta">${fmtTime(ep.createdAt)}</td>
</tr>`;
          })
          .join("");

  const hasCatalog = catalogTypes !== undefined && catalogTypes.length > 0;
  const eventTypesField = hasCatalog
    ? `<div class="form-row">
      <label>Event types</label>
      <label><input type="checkbox" name="subscribeAll" value="1"> Subscribe to all events</label>
      <div style="margin-top:8px">
        ${catalogTypes!.map((ct) => `<label><input type="checkbox" name="eventType" value="${esc(ct.id)}"> ${esc(ct.id)} — ${esc(ct.name)}</label>`).join("\n        ")}
      </div>
    </div>`
    : `<div class="form-row">
      <label for="eventTypes">Event types (leave blank to receive all)</label>
      <input id="eventTypes" type="text" name="eventTypes" placeholder="user.created, order.shipped">
      <div class="meta" style="margin-top:4px">Comma-separated list. Leave blank to receive every event type.</div>
    </div>`;

  const createForm = `<div class="card">
  <h2 style="margin-bottom:16px">Add endpoint</h2>
  ${errorBanner}
  <form method="POST" action="/portal/endpoints">
    <div class="form-row">
      <label for="url">URL <span style="color:#ef4444">*</span></label>
      <input id="url" type="url" name="url" placeholder="https://your-server.example/webhooks" required autocomplete="off">
    </div>
    <div class="form-row">
      <label for="description">Description</label>
      <input id="description" type="text" name="description" placeholder="Optional label">
    </div>
    ${eventTypesField}
    <div class="form-row">
      <label for="headers">Custom headers <span class="meta">(optional — one per line: Header-Name: value)</span></label>
      <textarea id="headers" name="headers" rows="3" placeholder="X-API-Key: my-key&#10;X-Tenant-ID: 123"></textarea>
    </div>
    <div class="form-row">
      <label for="rateLimit">Rate limit <span class="meta">(requests/min — leave blank for no limit)</span></label>
      <input id="rateLimit" type="number" name="rateLimit" min="1" placeholder="e.g. 100" style="max-width:180px">
    </div>
    <button type="submit" class="btn btn-blue">Create endpoint</button>
  </form>
</div>`;

  const body = `${secretBanner}<div class="section-head">
  <h2>Endpoints</h2>
</div>
<div class="card">
  <table>
    <thead>
      <tr><th>URL</th><th>Event types</th><th>Status</th><th>Created</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>
${createForm}`;

  return base("Endpoints", body);
}

export interface DeliveryRow {
  readonly task: DeliveryTask;
  readonly messageId: string;
}

/** Result of a portal test delivery, shown inline on the detail page. */
export interface PortalTestResult {
  readonly success: boolean;
  readonly httpStatus?: number;
  readonly error?: string;
  readonly durationMs: number;
}

/** Result of a portal signature-verification attempt, with echoed form fields for state preservation. */
export interface VerifyWidgetResult {
  readonly success: boolean;
  readonly error?: string;
  readonly webhookId?: string;
  readonly webhookTimestamp?: string;
  readonly webhookSignature?: string;
  readonly rawBody?: string;
}

/** Endpoint detail page — config + edit form + recent deliveries. */
export function portalEndpointDetailPage(
  endpoint: Endpoint,
  deliveries: readonly DeliveryRow[],
  error?: string,
  catalogTypes?: readonly { id: string; name: string }[],
  testResult?: PortalTestResult,
  verifyResult?: VerifyWidgetResult,
): string {
  const errorBanner = error
    ? `<div class="alert alert-err">${esc(error)}</div>`
    : "";

  const types =
    endpoint.eventTypes === null
      ? "All events"
      : endpoint.eventTypes.length === 0
        ? "None"
        : endpoint.eventTypes.join(", ");

  const deliveryRows =
    deliveries.length === 0
      ? `<tr><td colspan="4" class="empty">No deliveries yet for this endpoint.</td></tr>`
      : deliveries
          .map(
            (d) => `<tr>
  <td class="mono meta trunc"><a href="/portal/endpoints/${esc(endpoint.id)}/deliveries/${esc(d.task.id)}">${esc(d.messageId.slice(0, 20))}…</a></td>
  <td>${statusPill(d.task.status)}</td>
  <td class="meta">${d.task.attempts}</td>
  <td class="meta">${fmtTime(d.task.createdAt)}</td>
</tr>`,
          )
          .join("");

  const hasCatalog = catalogTypes !== undefined && catalogTypes.length > 0;
  const subscribeAll = endpoint.eventTypes === null;
  const subscribedSet = new Set(endpoint.eventTypes ?? []);
  const editEventTypesField = hasCatalog
    ? `<div class="form-row">
      <label>Event types</label>
      <label><input type="checkbox" name="subscribeAll" value="1"${subscribeAll ? " checked" : ""}> Subscribe to all events</label>
      <div style="margin-top:8px">
        ${catalogTypes!.map((ct) => `<label><input type="checkbox" name="eventType" value="${esc(ct.id)}"${subscribedSet.has(ct.id) ? " checked" : ""}> ${esc(ct.id)} — ${esc(ct.name)}</label>`).join("\n        ")}
      </div>
    </div>`
    : `<div class="form-row">
      <label for="eventTypes">Event types (leave blank for all)</label>
      <input id="eventTypes" type="text" name="eventTypes" value="${esc(endpoint.eventTypes !== null ? endpoint.eventTypes.join(", ") : "")}">
    </div>`;

  const headersText = endpoint.headers
    ? Object.entries(endpoint.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\n")
    : "";
  const editForm = `<div class="card">
  <h2 style="margin-bottom:16px">Edit endpoint</h2>
  ${errorBanner}
  <form method="POST" action="/portal/endpoints/${esc(endpoint.id)}/update">
    <div class="form-row">
      <label for="url">URL</label>
      <input id="url" type="url" name="url" value="${esc(endpoint.url)}" required autocomplete="off">
    </div>
    <div class="form-row">
      <label for="description">Description</label>
      <input id="description" type="text" name="description" value="${esc(endpoint.description)}">
    </div>
    ${editEventTypesField}
    <div class="form-row">
      <label for="headers">Custom headers <span class="meta">(one per line: Header-Name: value — clear all to remove)</span></label>
      <textarea id="headers" name="headers" rows="4" placeholder="X-API-Key: my-key&#10;X-Tenant-ID: 123">${esc(headersText)}</textarea>
    </div>
    <div class="form-row">
      <label for="rateLimit">Rate limit <span class="meta">(requests/min — leave blank to remove limit)</span></label>
      <input id="rateLimit" type="number" name="rateLimit" min="1" value="${endpoint.rateLimit !== null ? String(endpoint.rateLimit) : ""}" style="max-width:180px">
    </div>
    <div class="form-row" style="display:flex;gap:8px;align-items:center">
      <input type="checkbox" id="disabled" name="disabled" value="1"${endpoint.disabled ? " checked" : ""} style="width:auto">
      <label for="disabled" style="text-transform:none;letter-spacing:0;margin:0">Disabled (pauses delivery to this endpoint)</label>
    </div>
    <div style="display:flex;gap:8px;margin-top:4px">
      <button type="submit" class="btn btn-blue">Save changes</button>
    </div>
  </form>
</div>`;

  const testResultHtml = testResult
    ? testResult.success
      ? `<div class="alert alert-ok" style="margin-top:8px">
          Test succeeded — endpoint responded <strong>${esc(String(testResult.httpStatus ?? ""))}</strong>
          in ${esc(String(testResult.durationMs))} ms.
        </div>`
      : `<div class="alert alert-err" style="margin-top:8px">
          Test failed${testResult.httpStatus !== undefined ? ` — endpoint responded <strong>${esc(String(testResult.httpStatus))}</strong>` : ""}${testResult.error ? `: <span class="mono">${esc(testResult.error)}</span>` : ""}
          (${esc(String(testResult.durationMs))} ms).
        </div>`
    : "";
  const testForm = endpoint.disabled
    ? ""
    : `<div class="card">
  <h2 style="margin-bottom:8px">Test delivery</h2>
  <p class="meta" style="margin-bottom:12px">Send a one-shot signed test webhook to this endpoint URL and see the result immediately — no message is stored and quota is not consumed.</p>
  <form method="POST" action="/portal/endpoints/${esc(endpoint.id)}/test">
    <button type="submit" class="btn btn-gray">Send test</button>
  </form>
  ${testResultHtml}
</div>`;

  const rotateForm = `<div class="card">
  <h2 style="margin-bottom:8px">Signing secret</h2>
  <p class="meta" style="margin-bottom:12px">Rotate the signing secret when you need to reconfigure your webhook receiver. The old secret remains active for 24 h so you can update your server without downtime.</p>
  <form method="POST" action="/portal/endpoints/${esc(endpoint.id)}/rotate-secret">
    <button type="submit" class="btn btn-gray">Rotate secret</button>
  </form>
</div>`;

  const deleteForm = `<div class="card">
  <h2 style="margin-bottom:8px">Delete endpoint</h2>
  <p class="meta" style="margin-bottom:12px">Permanently remove this endpoint. Any in-flight deliveries will not be retried.</p>
  <form method="POST" action="/portal/endpoints/${esc(endpoint.id)}/delete" onsubmit="return confirm('Delete this endpoint? This cannot be undone.')">
    <button type="submit" class="btn btn-red">Delete endpoint</button>
  </form>
</div>`;

  const verifyResultHtml = verifyResult
    ? verifyResult.success
      ? `<div class="alert alert-ok" style="margin-top:10px">Signature verified — the webhook is authentic.</div>`
      : `<div class="alert alert-err" style="margin-top:10px">Verification failed: ${esc(verifyResult.error ?? "no matching signature found")}</div>`
    : "";

  const verifyForm = `<div class="card">
  <h2 style="margin-bottom:8px">Verify signature</h2>
  <p class="meta" style="margin-bottom:12px">Paste the three Standard Webhooks headers and the raw request body from a received webhook to confirm your server is extracting them correctly. Timestamp tolerance is relaxed so you can paste headers from earlier requests.</p>
  <form method="POST" action="/portal/endpoints/${esc(endpoint.id)}/verify">
    <div class="form-row">
      <label for="vWebhookId">webhook-id header</label>
      <input id="vWebhookId" type="text" name="webhookId" value="${esc(verifyResult?.webhookId ?? "")}" placeholder="msg_..." class="mono" autocomplete="off">
    </div>
    <div class="form-row">
      <label for="vWebhookTimestamp">webhook-timestamp header</label>
      <input id="vWebhookTimestamp" type="text" name="webhookTimestamp" value="${esc(verifyResult?.webhookTimestamp ?? "")}" placeholder="1717000000" class="mono" autocomplete="off">
    </div>
    <div class="form-row">
      <label for="vWebhookSig">webhook-signature header</label>
      <input id="vWebhookSig" type="text" name="webhookSignature" value="${esc(verifyResult?.webhookSignature ?? "")}" placeholder="v1,..." class="mono" autocomplete="off">
    </div>
    <div class="form-row">
      <label for="vRawBody">Raw request body (exact bytes — do not JSON.parse or re-serialize)</label>
      <textarea id="vRawBody" name="rawBody" rows="4" class="mono" placeholder='{"eventType":"user.created","data":{"id":1}}'>${esc(verifyResult?.rawBody ?? "")}</textarea>
    </div>
    <button type="submit" class="btn btn-gray">Verify</button>
  </form>
  ${verifyResultHtml}
  <details style="margin-top:14px">
    <summary style="cursor:pointer;font-size:12px;color:#64748b;font-weight:600;text-transform:uppercase;letter-spacing:.04em;user-select:none">Node.js code example</summary>
    <pre class="mono" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px;margin-top:8px;font-size:12px;overflow-x:auto;white-space:pre">import { verifyWebhook } from "posthorn";

// Inside your POST /webhooks handler — use the raw body string,
// NOT JSON.parse + re-serialize (that can change whitespace and break the signature).
try {
  verifyWebhook(process.env.WEBHOOK_SECRET, req.headers, rawBody);
  // Signature is valid — safe to process the event.
} catch {
  return res.status(401).end("invalid signature");
}</pre>
  </details>
</div>`;

  const body = `<h2 style="margin-bottom:4px">
  <a href="/portal/endpoints" style="color:#64748b;font-weight:400;font-size:13px">← Endpoints</a>
</h2>
<div class="card" style="margin-top:12px">
  <table style="width:auto">
    <tr><td style="color:#64748b;padding-right:24px;white-space:nowrap">URL</td><td class="mono">${esc(endpoint.url)}</td></tr>
    <tr><td style="color:#64748b">Description</td><td>${esc(endpoint.description) || '<span class="meta">—</span>'}</td></tr>
    <tr><td style="color:#64748b">Event types</td><td>${esc(types)}</td></tr>
    <tr><td style="color:#64748b;vertical-align:top">Custom headers</td><td class="mono">${endpoint.headers ? Object.entries(endpoint.headers).map(([k, v]) => `${esc(k)}: ${esc(v)}`).join("<br>") : '<span class="meta" style="font-style:normal">—</span>'}</td></tr>
    <tr><td style="color:#64748b">Rate limit</td><td>${endpoint.rateLimit !== null ? endpoint.rateLimit.toLocaleString() + " req/min" : '<span class="meta">No limit</span>'}</td></tr>
    <tr><td style="color:#64748b">Status</td><td>${endpoint.disabled ? '<span class="pill pill-gray">disabled</span>' : '<span class="pill pill-green">active</span>'}</td></tr>
    <tr><td style="color:#64748b">Created</td><td class="meta">${fmtTime(endpoint.createdAt)}</td></tr>
  </table>
</div>

<h2 style="margin-top:4px">Recent deliveries</h2>
<div class="card">
  <table>
    <thead>
      <tr><th>Message ID</th><th>Status</th><th>Attempts</th><th>Queued</th></tr>
    </thead>
    <tbody>${deliveryRows}</tbody>
  </table>
</div>

${editForm}
${testForm}
${verifyForm}
${rotateForm}
${deleteForm}`;

  return base(`Endpoint ${endpoint.id}`, body, `<a href="/portal/endpoints" style="color:#64748b;font-size:13px">← Endpoints</a>`);
}

/** Delivery detail page — status, last error, and a retry button for dead-lettered deliveries. */
export function portalDeliveryDetailPage(
  endpoint: Endpoint,
  task: DeliveryTask,
  retried = false,
): string {
  const retriedBanner = retried
    ? `<div class="alert alert-ok">Delivery queued for retry. The worker will attempt delivery again shortly.</div>`
    : "";

  const lastErrorCell = task.lastError
    ? `<td class="mono meta" style="max-width:400px;word-break:break-word">${esc(task.lastError)}</td>`
    : `<td class="meta">—</td>`;

  const retryForm =
    task.status === "dead_letter"
      ? `<div style="margin-top:16px">
  <form method="POST" action="/portal/endpoints/${esc(endpoint.id)}/deliveries/${esc(task.id)}/retry">
    <button type="submit" class="btn btn-blue">Retry delivery</button>
  </form>
</div>`
      : "";

  const body = `<h2 style="margin-bottom:4px">
  <a href="/portal/endpoints/${esc(endpoint.id)}" style="color:#64748b;font-weight:400;font-size:13px">← ${esc(endpoint.url)}</a>
</h2>
${retriedBanner}
<div class="card" style="margin-top:12px">
  <table style="width:auto">
    <tr><td style="color:#64748b;padding-right:24px;white-space:nowrap">Message</td><td class="mono meta">${esc(task.messageId)}</td></tr>
    <tr><td style="color:#64748b">Status</td><td>${statusPill(task.status)}</td></tr>
    <tr><td style="color:#64748b">Attempts</td><td class="meta">${task.attempts}</td></tr>
    <tr><td style="color:#64748b">Last error</td>${lastErrorCell}</tr>
    <tr><td style="color:#64748b">Queued</td><td class="meta">${fmtTime(task.createdAt)}</td></tr>
    <tr><td style="color:#64748b">Updated</td><td class="meta">${fmtTime(task.updatedAt)}</td></tr>
  </table>
  ${retryForm}
</div>`;

  return base(
    `Delivery ${task.id.slice(0, 12)}`,
    body,
    `<a href="/portal/endpoints/${esc(endpoint.id)}" style="color:#64748b;font-size:13px">← Endpoint</a>`,
  );
}

/** Event-types list page with inline create form. `created` is set right after creation. */
export function portalEventTypesPage(
  eventTypes: readonly EventType[],
  error?: string,
  created?: EventType,
): string {
  const errorBanner = error
    ? `<div class="alert alert-err">${esc(error)}</div>`
    : "";

  const createdBanner = created
    ? `<div class="alert alert-ok">Event type <strong>${esc(created.id)}</strong> created.</div>`
    : "";

  const rows =
    eventTypes.length === 0
      ? `<tr><td colspan="4" class="empty">No event types yet. Create one below.</td></tr>`
      : eventTypes
          .map(
            (et) => `<tr>
  <td class="mono"><a href="/portal/event-types/${esc(et.id)}">${esc(et.id)}</a></td>
  <td>${esc(et.name)}</td>
  <td class="meta">${et.description ? esc(et.description) : '<span class="meta">—</span>'}</td>
  <td>${et.archived ? '<span class="pill pill-gray">archived</span>' : '<span class="pill pill-green">active</span>'}</td>
</tr>`,
          )
          .join("");

  const createForm = `<div class="card">
  <h2 style="margin-bottom:16px">Add event type</h2>
  ${errorBanner}
  <form method="POST" action="/portal/event-types">
    <div class="form-row">
      <label for="etId">ID <span style="color:#ef4444">*</span></label>
      <input id="etId" type="text" name="id" placeholder="user.created" required autocomplete="off">
      <div class="meta" style="margin-top:4px">Start with a letter or digit; may contain letters, digits, dots, underscores, hyphens.</div>
    </div>
    <div class="form-row">
      <label for="etName">Name <span style="color:#ef4444">*</span></label>
      <input id="etName" type="text" name="name" placeholder="User created" required>
    </div>
    <div class="form-row">
      <label for="etDesc">Description <span class="meta">(optional)</span></label>
      <input id="etDesc" type="text" name="description" placeholder="Fired when a new user account is created">
    </div>
    <div class="form-row">
      <label for="etSchema">Example payload <span class="meta">(optional — must be valid JSON)</span></label>
      <textarea id="etSchema" name="schemaExample" rows="4" class="mono" placeholder='{"id": 1, "email": "user@example.com"}'></textarea>
    </div>
    <button type="submit" class="btn btn-blue">Create event type</button>
  </form>
</div>`;

  const body = `${createdBanner}<div class="section-head">
  <h2>Event types</h2>
</div>
<div class="card">
  <table>
    <thead>
      <tr><th>ID</th><th>Name</th><th>Description</th><th>Status</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>
${createForm}`;

  return base("Event types", body);
}

/** Event-type detail page — config summary + edit form + archive action. */
export function portalEventTypeDetailPage(
  eventType: EventType,
  error?: string,
  saved = false,
  subscribers?: readonly Pick<Endpoint, "id" | "url" | "description" | "disabled">[],
): string {
  const errorBanner = error
    ? `<div class="alert alert-err">${esc(error)}</div>`
    : "";

  const savedBanner = saved
    ? `<div class="alert alert-ok">Changes saved.</div>`
    : "";

  const editForm = `<div class="card">
  <h2 style="margin-bottom:16px">Edit event type</h2>
  ${savedBanner}
  ${errorBanner}
  <form method="POST" action="/portal/event-types/${esc(eventType.id)}/update">
    <div class="form-row">
      <label for="etName">Name <span style="color:#ef4444">*</span></label>
      <input id="etName" type="text" name="name" value="${esc(eventType.name)}" required>
    </div>
    <div class="form-row">
      <label for="etDesc">Description <span class="meta">(optional)</span></label>
      <input id="etDesc" type="text" name="description" value="${esc(eventType.description ?? "")}">
    </div>
    <div class="form-row">
      <label for="etSchema">Example payload <span class="meta">(optional — must be valid JSON)</span></label>
      <textarea id="etSchema" name="schemaExample" rows="4" class="mono">${esc(eventType.schemaExample ?? "")}</textarea>
    </div>
    <button type="submit" class="btn btn-blue">Save changes</button>
  </form>
</div>`;

  const archiveSection = eventType.archived
    ? `<div class="card">
  <p class="meta"><span class="pill pill-gray">archived</span> This event type is archived and hidden from subscription suggestions. Existing subscriptions continue to work.</p>
</div>`
    : `<div class="card">
  <h2 style="margin-bottom:8px">Archive event type</h2>
  <p class="meta" style="margin-bottom:12px">Archived event types are hidden from subscription suggestions. Existing subscriptions that reference this type continue to work.</p>
  <form method="POST" action="/portal/event-types/${esc(eventType.id)}/archive" onsubmit="return confirm('Archive this event type?')">
    <button type="submit" class="btn btn-gray">Archive</button>
  </form>
</div>`;

  const subscribersSection = (() => {
    if (!subscribers || subscribers.length === 0) {
      return `<div class="card">
  <h2>Subscribed endpoints</h2>
  <p class="empty">No endpoints are subscribed to this event type.</p>
</div>`;
    }
    const rows = subscribers
      .map(
        (ep) => `<tr>
  <td><a href="/portal/endpoints/${esc(ep.id)}">${esc(ep.id)}</a><br><span class="meta trunc">${esc(ep.url)}</span></td>
  <td>${ep.description ? esc(ep.description) : '<span class="meta">—</span>'}</td>
  <td>${ep.disabled ? '<span class="pill pill-gray">disabled</span>' : '<span class="pill pill-green">active</span>'}</td>
</tr>`,
      )
      .join("\n");
    return `<div class="card">
  <h2>Subscribed endpoints</h2>
  <table>
    <thead><tr><th>Endpoint</th><th>Description</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;
  })();

  const body = `<h2 style="margin-bottom:4px">
  <a href="/portal/event-types" style="color:#64748b;font-weight:400;font-size:13px">← Event types</a>
</h2>
<div class="card" style="margin-top:12px">
  <table style="width:auto">
    <tr><td style="color:#64748b;padding-right:24px;white-space:nowrap">ID</td><td class="mono">${esc(eventType.id)}</td></tr>
    <tr><td style="color:#64748b">Name</td><td>${esc(eventType.name)}</td></tr>
    <tr><td style="color:#64748b">Description</td><td>${eventType.description ? esc(eventType.description) : '<span class="meta">—</span>'}</td></tr>
    <tr><td style="color:#64748b;vertical-align:top">Example payload</td><td>${eventType.schemaExample ? `<pre class="mono" style="font-size:12px;white-space:pre-wrap;word-break:break-all">${esc(eventType.schemaExample)}</pre>` : '<span class="meta">—</span>'}</td></tr>
    <tr><td style="color:#64748b">Status</td><td>${eventType.archived ? '<span class="pill pill-gray">archived</span>' : '<span class="pill pill-green">active</span>'}</td></tr>
    <tr><td style="color:#64748b">Created</td><td class="meta">${fmtTime(eventType.createdAt)}</td></tr>
  </table>
</div>

${subscribersSection}
${editForm}
${archiveSection}`;

  return base(
    `Event type ${eventType.id}`,
    body,
    `<a href="/portal/event-types" style="color:#64748b;font-size:13px">← Event types</a>`,
  );
}

/** Page shown after rotating the secret — displays the new secret once. */
export function portalRotatedSecretPage(endpoint: Endpoint, newSecret: string): string {
  const body = `<h2 style="margin-bottom:4px">
  <a href="/portal/endpoints/${esc(endpoint.id)}" style="color:#64748b;font-weight:400;font-size:13px">← Endpoint</a>
</h2>
<div class="banner" style="margin-top:12px">
  <label>New signing secret (shown once — copy it now)</label>
  <div class="secret-val">${esc(newSecret)}</div>
  <p>Update your server to use this secret. The previous secret stays active for 24 h so you can update without downtime.</p>
</div>
<p><a href="/portal/endpoints/${esc(endpoint.id)}" class="btn btn-gray">← Back to endpoint</a></p>`;

  return base("Secret rotated", body);
}
