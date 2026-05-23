/**
 * Pure HTML string builders for the admin dashboard.
 *
 * All user-supplied strings are escaped through {@link esc} before insertion so
 * the templates are XSS-safe regardless of content. No external dependencies —
 * the same zero-dep philosophy as the rest of the stack. Styles are inlined so
 * the dashboard works with no static-asset serving.
 */

import type { App, ApiKey } from "../apps/app.js";

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
.wrap{max-width:960px;margin:0 auto;padding:20px}
h2{font-size:15px;font-weight:600;margin-bottom:14px;color:#111827}
h3{font-size:13px;font-weight:600;margin:16px 0 10px;color:#374151;text-transform:uppercase;letter-spacing:.04em}
.card{background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:18px;margin-bottom:16px}
.alert{padding:10px 14px;border-radius:6px;margin-bottom:14px;font-size:13px}
.alert-err{background:#fef2f2;color:#b91c1c;border:1px solid #fecaca}
.alert-ok{background:#f0fdf4;color:#15803d;border:1px solid #bbf7d0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #f3f4f6;font-size:13px;vertical-align:middle}
th{background:#f9fafb;font-weight:600;color:#6b7280;font-size:11px;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #e5e7eb}
tr:last-child td{border-bottom:none}
tr:hover td{background:#fafafa}
.btn{display:inline-flex;align-items:center;padding:6px 12px;border:none;border-radius:6px;font-size:13px;font-weight:500;cursor:pointer;text-decoration:none;line-height:1}
.btn:hover{text-decoration:none;filter:brightness(.93)}
.btn-blue{background:#2563eb;color:#fff}
.btn-red{background:#ef4444;color:#fff}
.btn-gray{background:#e5e7eb;color:#374151}
.btn-sm{padding:4px 8px;font-size:12px}
.btn-link{background:none;color:#2563eb;padding:4px 6px;font-size:12px;font-weight:500;cursor:pointer;border:none}
.btn-link:hover{text-decoration:underline}
input[type=text],input[type=password],input[type=number]{padding:6px 10px;border:1px solid #d1d5db;border-radius:6px;font-size:13px;outline:none}
input:focus{border-color:#2563eb;box-shadow:0 0 0 3px rgba(37,99,235,.1)}
label{display:block;font-size:12px;font-weight:600;margin-bottom:3px;color:#374151;text-transform:uppercase;letter-spacing:.04em}
.form-row{display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap}
.form-group{display:flex;flex-direction:column}
.secret{font-family:ui-monospace,SFMono-Regular,monospace;background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:10px;font-size:12px;word-break:break-all;margin-top:6px;color:#0f172a}
.pill{display:inline-block;padding:2px 7px;border-radius:9999px;font-size:11px;font-weight:600}
.pill-green{background:#dcfce7;color:#15803d}
.pill-gray{background:#f3f4f6;color:#6b7280}
.mono{font-family:ui-monospace,SFMono-Regular,monospace;font-size:12px}
.meta{color:#6b7280;font-size:12px}
.empty{color:#6b7280;font-size:13px;font-style:italic;padding:10px 0}
/* login */
.login-wrap{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f6}
.login-box{background:#fff;border:1px solid #e5e7eb;border-radius:12px;padding:32px;width:380px;box-shadow:0 4px 16px rgba(0,0,0,.06)}
.login-box .logo{font-size:22px;font-weight:800;text-align:center;margin-bottom:4px}
.login-box .logo span{color:#2563eb}
.login-box .sub{color:#6b7280;font-size:13px;text-align:center;margin-bottom:22px}
.login-box .btn{width:100%;justify-content:center;margin-top:4px;padding:9px}
.login-box input{width:100%;margin-bottom:10px}
`;

function base(title: string, body: string, nav = ""): string {
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
  <div class="brand">Post<span>horn</span> <span style="color:#94a3b8;font-weight:400;font-size:12px">admin</span></div>
  <nav>${nav}</nav>
</header>
<div class="wrap">
${body}
</div>
</body>
</html>`;
}

/** Login form page. Pass an error string to display an inline error. */
export function loginPage(error?: string): string {
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
    <div class="sub">Admin Dashboard</div>
    ${error ? `<div class="alert alert-err">${esc(error)}</div>` : ""}
    <form method="POST" action="/dashboard/login">
      <label for="token">Admin Token</label>
      <input id="token" type="password" name="token" placeholder="Enter POSTHORN_ADMIN_TOKEN" autofocus required>
      <button type="submit" class="btn btn-blue">Sign in</button>
    </form>
  </div>
</div>
</body>
</html>`;
}

/** Apps list page showing all tenants with a create form. */
export function appsPage(apps: readonly App[]): string {
  const nav = `<form method="POST" action="/dashboard/logout" style="display:inline">
    <button type="submit" class="btn btn-gray btn-sm">Sign out</button>
  </form>`;

  const tableRows =
    apps.length === 0
      ? `<tr><td colspan="4" class="empty">No apps yet.</td></tr>`
      : apps
          .map(
            (app) => `<tr>
    <td><a href="/dashboard/apps/${esc(app.id)}">${esc(app.name !== "" ? app.name : app.id)}</a></td>
    <td class="mono meta">${esc(app.id)}</td>
    <td class="meta">${new Date(app.createdAt).toISOString().slice(0, 10)}</td>
    <td class="meta">${app.monthlyMessageQuota !== null ? app.monthlyMessageQuota.toLocaleString() : "Unlimited"}</td>
  </tr>`,
          )
          .join("");

  const body = `<h2>Apps</h2>
<div class="card">
  <table>
    <thead>
      <tr><th>Name</th><th>ID</th><th>Created</th><th>Monthly quota</th></tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</div>
<h3>Create app</h3>
<div class="card">
  <form method="POST" action="/dashboard/apps">
    <div class="form-row">
      <div class="form-group">
        <label for="name">Name</label>
        <input id="name" type="text" name="name" placeholder="My App" style="width:220px">
      </div>
      <div class="form-group">
        <label for="quota">Monthly message quota</label>
        <input id="quota" type="number" name="quota" placeholder="blank = unlimited" min="0" style="width:200px">
      </div>
      <button type="submit" class="btn btn-blue">Create</button>
    </div>
  </form>
</div>`;

  return base("Apps", body, nav);
}

/** App detail page with keys, create-key form, and danger zone. */
export function appDetailPage(
  app: App,
  keys: readonly ApiKey[],
  newKeySecret?: string,
): string {
  const nav = `<a href="/dashboard/apps" style="color:#94a3b8;font-size:13px">← Apps</a>
  <form method="POST" action="/dashboard/logout" style="display:inline;margin-left:12px">
    <button type="submit" class="btn btn-gray btn-sm">Sign out</button>
  </form>`;

  const newKeyBanner = newKeySecret
    ? `<div class="alert alert-ok">
  <strong>New API key created.</strong> Copy this secret — it will not be shown again.
  <div class="secret">${esc(newKeySecret)}</div>
</div>`
    : "";

  const keyRows =
    keys.length === 0
      ? `<tr><td colspan="5" class="empty">No keys yet.</td></tr>`
      : keys
          .map(
            (k) => `<tr>
    <td class="mono">${esc(k.prefix)}…</td>
    <td class="mono meta">${esc(k.id)}</td>
    <td class="meta">${new Date(k.createdAt).toISOString().slice(0, 10)}</td>
    <td><span class="pill ${k.revokedAt !== null ? "pill-gray" : "pill-green"}">${k.revokedAt !== null ? "Revoked" : "Active"}</span></td>
    <td>${
      k.revokedAt === null
        ? `<form method="POST" action="/dashboard/apps/${esc(app.id)}/keys/${esc(k.id)}/revoke" style="display:inline">
          <button type="submit" class="btn btn-link">Revoke</button>
        </form>`
        : ""
    }</td>
  </tr>`,
          )
          .join("");

  const body = `<h2>${esc(app.name !== "" ? app.name : app.id)}</h2>
<div class="card">
  <table style="width:auto">
    <tr><td style="color:#6b7280;padding-right:24px">ID</td><td class="mono">${esc(app.id)}</td></tr>
    <tr><td style="color:#6b7280">Created</td><td class="meta">${new Date(app.createdAt).toISOString().slice(0, 19).replace("T", " ")} UTC</td></tr>
    <tr><td style="color:#6b7280">Monthly quota</td><td>${app.monthlyMessageQuota !== null ? app.monthlyMessageQuota.toLocaleString() + " messages" : '<span class="meta">Unlimited</span>'}</td></tr>
  </table>
</div>
${newKeyBanner}
<h3>API Keys</h3>
<div class="card">
  <table>
    <thead>
      <tr><th>Prefix</th><th>Key ID</th><th>Created</th><th>Status</th><th></th></tr>
    </thead>
    <tbody>${keyRows}</tbody>
  </table>
  <div style="margin-top:14px">
    <form method="POST" action="/dashboard/apps/${esc(app.id)}/keys" style="display:inline">
      <button type="submit" class="btn btn-blue">Create API key</button>
    </form>
  </div>
</div>
<h3>Danger zone</h3>
<div class="card">
  <p class="meta" style="margin-bottom:12px">Permanently delete this app and all its API keys. This cannot be undone.</p>
  <form method="POST" action="/dashboard/apps/${esc(app.id)}/delete" onsubmit="return confirm('Delete ${esc(app.name !== "" ? app.name : app.id)} and all its keys? This cannot be undone.')">
    <button type="submit" class="btn btn-red">Delete app</button>
  </form>
</div>`;

  return base(`App: ${app.name !== "" ? app.name : app.id}`, body, nav);
}
