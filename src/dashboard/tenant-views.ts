/**
 * Pure HTML string builders for the tenant dashboard.
 *
 * All user-supplied strings are escaped through {@link esc} before insertion so
 * the templates are XSS-safe regardless of content. Styles are inlined; no
 * external assets, zero dependencies — the same posture as the admin dashboard.
 */

import type { Message } from "../storage/message-store.js";
import type { DeliveryTask } from "../queue/delivery-queue.js";
import type { DeliveryAttempt } from "../attempts/delivery-attempt.js";
import type { Endpoint } from "../endpoints/endpoint.js";

/** Escape HTML entities to prevent XSS from user-supplied strings. */
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
body{font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif;background:#f3f4f6;color:#111827;font-size:14px;line-height:1.5}
a{color:#2563eb;text-decoration:none}a:hover{text-decoration:underline}
header{background:#1e293b;color:#f8fafc;padding:10px 20px;display:flex;align-items:center;justify-content:space-between;gap:12px}
header .brand{font-size:15px;font-weight:700;letter-spacing:-.3px;color:#f8fafc}
header .brand span{color:#60a5fa}
header nav{display:flex;align-items:center;gap:4px}
.wrap{max-width:1080px;margin:0 auto;padding:20px}
h2{font-size:15px;font-weight:600;margin-bottom:14px;color:#111827}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px;margin-bottom:16px}
.alert{padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:13px}
.alert-err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:13px;vertical-align:middle}
th{background:#f9fafb;font-weight:600;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
.btn{display:inline-flex;align-items:center;padding:6px 12px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;line-height:1}
.btn:hover{text-decoration:none;filter:brightness(.93)}
.btn-blue{background:#2563eb;color:#fff}
.btn-gray{background:#e5e7eb;color:#374151}
.btn-sm{padding:4px 8px;font-size:12px}
input[type=text],input[type=password]{padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;outline:none;width:100%}
input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
label{display:block;font-size:12px;font-weight:600;margin-bottom:3px;color:#374151;text-transform:uppercase;letter-spacing:.04em}
.pill{display:inline-block;padding:2px 7px;border-radius:9999px;font-size:11px;font-weight:600}
.pill-green{background:#dcfce7;color:#15803d}
.pill-yellow{background:#fef9c3;color:#92400e}
.pill-red{background:#fee2e2;color:#b91c1c}
.pill-gray{background:#f3f4f6;color:#6b7280}
.pill-blue{background:#dbeafe;color:#1d4ed8}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
.meta{color:#6b7280;font-size:12px}
.empty{color:#6b7280;font-size:13px;font-style:italic;padding:10px 0}
.trunc{max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.payload{font-family:ui-monospace,SFMono-Regular,monospace;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:12px;word-break:break-all;overflow-wrap:anywhere;white-space:pre-wrap;max-height:200px;overflow-y:auto}
.pagination{display:flex;gap:8px;align-items:center;padding-top:14px}
/* login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6}
.login-box{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;width:400px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
.login-box .logo{font-size:22px;font-weight:800;text-align:center;margin-bottom:4px}
.login-box .logo span{color:#2563eb}
.login-box .sub{color:#6b7280;font-size:13px;text-align:center;margin-bottom:22px}
.login-box .btn{width:100%;justify-content:center;margin-top:4px;padding:9px}
.login-box input{margin-bottom:10px}
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

function outcomePill(outcome: string): string {
  return outcome === "succeeded"
    ? `<span class="pill pill-green">succeeded</span>`
    : `<span class="pill pill-red">failed</span>`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ") + " UTC";
}

function fmtMs(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function base(title: string, body: string, nav: string, activePage: string): string {
  const navLinks = ["messages", "endpoints"]
    .map((p) => {
      const active = activePage === p;
      return `<a href="/dashboard/tenant/${p}" style="${active ? "color:#f8fafc;font-weight:600" : "color:#94a3b8"}">${p.charAt(0).toUpperCase() + p.slice(1)}</a>`;
    })
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Posthorn</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div style="display:flex;align-items:center;gap:16px">
    <div class="brand">Post<span>horn</span> <span style="color:#94a3b8;font-weight:400;font-size:12px">dashboard</span></div>
    <nav style="display:flex;gap:12px">${navLinks}</nav>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    ${nav}
    <form method="POST" action="/dashboard/tenant/logout" style="display:inline">
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

/** Login form page. Pass an error string to display an inline error. */
export function tenantLoginPage(error?: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in — Posthorn</title>
<style>${CSS}</style>
</head>
<body>
<div class="login-wrap">
  <div class="login-box">
    <div class="logo">Post<span>horn</span></div>
    <div class="sub">Developer Dashboard</div>
    ${error ? `<div class="alert alert-err">${esc(error)}</div>` : ""}
    <form method="POST" action="/dashboard/tenant/login">
      <label for="apikey">API Key</label>
      <input id="apikey" type="password" name="apikey" placeholder="phk_…" autofocus required>
      <button type="submit" class="btn btn-blue">Sign in</button>
    </form>
  </div>
</div>
</body>
</html>`;
}

/** Current-month usage and quota for the usage bar. */
export interface UsageStats {
  readonly currentMonth: number;
  readonly quota: number | null;
  readonly periodStart: string;
  readonly resetsAt: string;
}

/** Compact usage bar shown at the top of the messages page. */
function usageBar(stats: UsageStats): string {
  const { currentMonth, quota, periodStart, resetsAt } = stats;
  if (quota === null) {
    return `<div class="card" style="padding:12px 18px;display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px">
  <span style="font-size:13px;color:#374151">This month (${periodStart} – ${resetsAt}): <strong>${currentMonth.toLocaleString()}</strong> messages sent</span>
  <span class="meta">No quota</span>
</div>`;
  }
  const remaining = Math.max(0, quota - currentMonth);
  const pct = quota > 0 ? Math.min(100, Math.round((currentMonth / quota) * 100)) : 100;
  const barColor = pct >= 90 ? "#ef4444" : pct >= 75 ? "#f59e0b" : "#2563eb";
  return `<div class="card" style="padding:12px 18px;margin-bottom:16px">
  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:8px">
    <span style="font-size:13px;color:#374151"><strong>${currentMonth.toLocaleString()}</strong> / ${quota.toLocaleString()} messages this month</span>
    <span class="meta">${remaining.toLocaleString()} remaining · resets ${resetsAt}</span>
  </div>
  <div style="height:6px;border-radius:3px;background:#e5e7eb;overflow:hidden">
    <div style="height:100%;width:${pct}%;background:${barColor};border-radius:3px"></div>
  </div>
</div>`;
}

/** Messages list page — newest-first, paginated. */
export function tenantMessagesPage(
  messages: readonly Message[],
  nextCursor: string | null,
  currentCursor?: string,
  usageStats?: UsageStats,
): string {
  const rows =
    messages.length === 0
      ? `<tr><td colspan="4" class="empty">No messages yet.</td></tr>`
      : messages
          .map(
            (m) => `<tr>
  <td><a href="/dashboard/tenant/messages/${esc(m.id)}" class="mono">${esc(m.id.slice(0, 20))}…</a></td>
  <td>${esc(m.eventType)}</td>
  <td class="mono meta">${m.idempotencyKey !== null ? esc(m.idempotencyKey) : '<span class="meta">—</span>'}</td>
  <td class="meta">${fmtTime(m.createdAt)}</td>
</tr>`,
          )
          .join("");

  const pagination = nextCursor
    ? `<div class="pagination"><a href="/dashboard/tenant/messages?cursor=${encodeURIComponent(nextCursor)}" class="btn btn-gray btn-sm">Older →</a></div>`
    : currentCursor
      ? `<div class="pagination"><span class="meta">End of results</span></div>`
      : "";

  const usageSection = usageStats !== undefined ? usageBar(usageStats) : "";

  const body = `<h2>Messages</h2>
${usageSection}<div class="card">
  <table>
    <thead>
      <tr><th>ID</th><th>Event Type</th><th>Idempotency Key</th><th>Sent</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
  ${pagination}
</div>`;

  return base("Messages", body, "", "messages");
}

/** Delivery task enriched with endpoint URL (resolved at display time). */
export interface EnrichedDelivery {
  readonly task: DeliveryTask;
  readonly endpointUrl: string | null;
}

/** Message detail page — deliveries per endpoint + per-attempt audit log. */
export function tenantMessageDetailPage(
  message: Message,
  deliveries: readonly EnrichedDelivery[],
  attemptLog: readonly DeliveryAttempt[],
): string {
  const nav = `<a href="/dashboard/tenant/messages" style="color:#94a3b8;font-size:13px">← Messages</a>`;

  const deliveryRows =
    deliveries.length === 0
      ? `<tr><td colspan="5" class="empty">No deliveries — no endpoints subscribed to this event type at send time.</td></tr>`
      : deliveries
          .map(
            (d) => `<tr>
  <td class="mono trunc">${d.endpointUrl !== null ? esc(d.endpointUrl) : `<span class="meta">${esc(d.task.endpointId ?? "—")}</span>`}</td>
  <td>${statusPill(d.task.status)}</td>
  <td class="meta">${d.task.attempts}</td>
  <td class="meta">${d.task.nextAttemptAt !== null && d.task.status === "pending" ? fmtTime(d.task.nextAttemptAt) : "—"}</td>
  <td class="mono meta trunc">${d.task.lastError !== null ? esc(d.task.lastError) : "—"}</td>
</tr>`,
          )
          .join("");

  const attemptRows =
    attemptLog.length === 0
      ? `<tr><td colspan="6" class="empty">No attempt records yet.</td></tr>`
      : attemptLog
          .map(
            (a) => `<tr>
  <td class="meta">${a.attemptNumber}</td>
  <td>${outcomePill(a.outcome)}</td>
  <td class="meta">${a.responseStatus !== null ? a.responseStatus : "—"}</td>
  <td class="meta">${fmtMs(a.durationMs)}</td>
  <td class="mono meta trunc">${a.error !== null ? esc(a.error) : "—"}</td>
  <td class="meta">${fmtTime(a.attemptedAt)}</td>
</tr>`,
          )
          .join("");

  // Truncate payload display at 2000 chars to avoid enormous pages.
  const payloadDisplay =
    message.payload.length > 2000
      ? message.payload.slice(0, 2000) + "…"
      : message.payload;

  const body = `<h2>Message <span class="mono" style="font-size:13px;font-weight:400">${esc(message.id)}</span></h2>
<div class="card">
  <table style="width:auto">
    <tr><td style="color:#6b7280;padding-right:24px;white-space:nowrap">Event type</td><td>${esc(message.eventType)}</td></tr>
    <tr><td style="color:#6b7280">Idempotency key</td><td class="mono">${message.idempotencyKey !== null ? esc(message.idempotencyKey) : '<span class="meta">—</span>'}</td></tr>
    <tr><td style="color:#6b7280">Sent</td><td class="meta">${fmtTime(message.createdAt)}</td></tr>
  </table>
  <div style="margin-top:14px">
    <label>Payload</label>
    <div class="payload">${esc(payloadDisplay)}</div>
  </div>
</div>

<h2 style="margin-top:4px">Deliveries</h2>
<div class="card">
  <table>
    <thead>
      <tr><th>Endpoint</th><th>Status</th><th>Attempts</th><th>Next Attempt</th><th>Last Error</th></tr>
    </thead>
    <tbody>${deliveryRows}</tbody>
  </table>
</div>

<h2 style="margin-top:4px">Attempt Log</h2>
<div class="card">
  <table>
    <thead>
      <tr><th>#</th><th>Outcome</th><th>HTTP Status</th><th>Duration</th><th>Error</th><th>Attempted</th></tr>
    </thead>
    <tbody>${attemptRows}</tbody>
  </table>
</div>`;

  return base(`Message ${message.id}`, body, nav, "messages");
}

/** Endpoints list page. */
export function tenantEndpointsPage(endpoints: readonly Endpoint[]): string {
  const rows =
    endpoints.length === 0
      ? `<tr><td colspan="4" class="empty">No endpoints configured. Use the API or SDK to create one.</td></tr>`
      : endpoints
          .map((ep) => {
            const types =
              ep.eventTypes === null
                ? '<span class="pill pill-gray">All events</span>'
                : ep.eventTypes.length === 0
                  ? '<span class="meta">—</span>'
                  : ep.eventTypes.map((t) => `<span class="pill pill-gray">${esc(t)}</span>`).join(" ");
            const health =
              ep.consecutiveFailures > 0
                ? `<span class="pill pill-red">${ep.consecutiveFailures} failures</span>`
                : "";
            const status = ep.disabled
              ? `<span class="pill pill-gray">disabled</span> ${health}`
              : `<span class="pill pill-green">active</span> ${health}`;
            return `<tr>
  <td class="mono trunc"><span title="${esc(ep.url)}">${esc(ep.url)}</span></td>
  <td style="max-width:200px">${types}</td>
  <td>${status}</td>
  <td class="meta">${fmtTime(ep.createdAt)}</td>
</tr>`;
          })
          .join("");

  const body = `<h2>Endpoints</h2>
<p class="meta" style="margin-bottom:14px">Manage endpoints via the <a href="/openapi.json">API</a> or the TypeScript SDK.</p>
<div class="card">
  <table>
    <thead>
      <tr><th>URL</th><th>Event Types</th><th>Status</th><th>Created</th></tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>
</div>`;

  return base("Endpoints", body, "", "endpoints");
}
