import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { renderAdminDashboardPage, renderTenantDashboardPage } from '../src/dashboard';

const OUTPUT_DIR = resolve(__dirname, '../roadmap/evidence/frontend-visuals');
mkdirSync(OUTPUT_DIR, { recursive: true });

// 1. Generate Populated Admin Dashboard HTML
let adminHtml = renderAdminDashboardPage();

const adminInjectedRows = `
<tr class="selected">
  <td class="mono">Acme Corp\napp_acme</td>
  <td>Unlimited</td>
  <td>6/12/2026, 12:00:00 PM</td>
  <td><button class="primary" type="button">Select</button></td>
</tr>
<tr>
  <td class="mono">Beta Ltd\napp_beta</td>
  <td>50000</td>
  <td>6/15/2026, 9:30:00 AM</td>
  <td><button class="primary" type="button">Select</button></td>
</tr>
`;

const adminInjectedUsage = `
<div><span class="pill">Month</span><div class="mono">2026-06</div></div>
<div><span class="pill">Messages</span><div class="mono">12450</div></div>
<div><span class="pill">Delivery attempts</span><div class="mono">13100</div></div>
<div><span class="pill">Remaining</span><div class="mono">Unlimited</div></div>
`;

const adminInjectedKeys = `
<tr>
  <td class="mono">ak_acme_primary</td>
  <td>Primary Key</td>
  <td>6/12/2026, 12:01:00 PM</td>
  <td></td>
  <td><button class="danger" type="button">Revoke</button></td>
</tr>
<tr>
  <td class="mono">ak_acme_stale</td>
  <td>Stale Key</td>
  <td>6/12/2026, 12:01:00 PM</td>
  <td>6/14/2026, 3:45:00 PM</td>
  <td><button class="danger" type="button" disabled>Revoke</button></td>
</tr>
`;

adminHtml = adminHtml
  .replace('<tbody id="tenant-rows"></tbody>', `<tbody id="tenant-rows">${adminInjectedRows}</tbody>`)
  .replace('<div id="usage-summary" class="row"></div>', `<div id="usage-summary" class="row">${adminInjectedUsage}</div>`)
  .replace('<tbody id="key-rows"></tbody>', `<tbody id="key-rows">${adminInjectedKeys}</tbody>`)
  .replace('id="admin-auth-status" class="status" data-state="empty">Waiting for admin token.', 'id="admin-auth-status" class="status" data-state="success">Connected.')
  .replace('id="tenant-list-status" class="status" data-state="empty">No request sent.', 'id="tenant-list-status" class="status" data-state="success">2 tenants.')
  .replace('id="usage-status" class="status" data-state="empty">Select a tenant.', 'id="usage-status" class="status" data-state="success">Acme Corp')
  .replace('id="key-list-status" class="status" data-state="empty">Select a tenant.', 'id="key-list-status" class="status" data-state="success">2 keys.');

adminHtml = adminHtml.replace(/<script>[\s\S]*?<\/script>/g, '');
writeFileSync(join(OUTPUT_DIR, 'admin-dashboard.html'), adminHtml);

// 2. Generate Populated Tenant Dashboard HTML (Main View)
let tenantHtml = renderTenantDashboardPage();

const tenantUsage = `
<div><span class="pill">Month</span><div class="mono">2026-06</div></div>
<div><span class="pill">Messages</span><div class="mono">12450</div></div>
<div><span class="pill">Delivery attempts</span><div class="mono">13100</div></div>
<div><span class="pill">Remaining</span><div class="mono">Unlimited</div></div>
`;

const tenantEndpoints = `
<tr>
  <td class="mono">ep_001\nhttps://acme.com/webhooks</td>
  <td>user.created, user.deleted</td>
  <td>Yes</td>
</tr>
<tr>
  <td class="mono">ep_002\nhttps://acme.com/analytics</td>
  <td>All</td>
  <td>Yes</td>
</tr>
`;

const tenantMessages = `
<tr>
  <td class="mono">msg_001</td>
  <td>user.created</td>
  <td>6/17/2026, 12:00:00 PM</td>
  <td><button class="primary" type="button">Inspect</button></td>
</tr>
<tr>
  <td class="mono">msg_002</td>
  <td>payment.succeeded</td>
  <td>6/17/2026, 12:05:00 PM</td>
  <td><button class="primary" type="button">Inspect</button></td>
</tr>
`;

tenantHtml = tenantHtml
  .replace('<div id="tenant-usage-summary" class="row"></div>', `<div id="tenant-usage-summary" class="row">${tenantUsage}</div>`)
  .replace('<tbody id="endpoint-rows"></tbody>', `<tbody id="endpoint-rows">${tenantEndpoints}</tbody>`)
  .replace('<tbody id="message-rows"></tbody>', `<tbody id="message-rows">${tenantMessages}</tbody>`)
  .replace('id="tenant-auth-status" class="status" data-state="empty">Waiting for API key.', 'id="tenant-auth-status" class="status" data-state="success">Connected.')
  .replace('id="tenant-usage-status" class="status" data-state="empty">No request sent.', 'id="tenant-usage-status" class="status" data-state="success">Usage loaded.')
  .replace('id="endpoint-status" class="status" data-state="empty">No request sent.', 'id="endpoint-status" class="status" data-state="success">2 endpoints.')
  .replace('id="message-list-status" class="status" data-state="empty">No request sent.', 'id="message-list-status" class="status" data-state="success">2 messages.');

const tenantMainHtml = tenantHtml.replace(/<script>[\s\S]*?<\/script>/g, '');
writeFileSync(join(OUTPUT_DIR, 'tenant-dashboard.html'), tenantMainHtml);

// 3. Generate Populated Tenant Dashboard HTML (Details Selected View)
const tenantSelectedMessages = `
<tr class="selected">
  <td class="mono">msg_001</td>
  <td>user.created</td>
  <td>6/17/2026, 12:00:00 PM</td>
  <td><button class="primary" type="button">Inspect</button></td>
</tr>
<tr>
  <td class="mono">msg_002</td>
  <td>payment.succeeded</td>
  <td>6/17/2026, 12:05:00 PM</td>
  <td><button class="primary" type="button">Inspect</button></td>
</tr>
`;

const tenantDeliveries = `
<tr>
  <td class="mono">del_001</td>
  <td class="mono">ep_001</td>
  <td>succeeded</td>
  <td>1</td>
</tr>
<tr>
  <td class="mono">del_002</td>
  <td class="mono">ep_002</td>
  <td>succeeded</td>
  <td>1</td>
</tr>
`;

const tenantAttempts = `
<tr>
  <td>1</td>
  <td>succeeded</td>
  <td>200</td>
  <td></td>
  <td>6/17/2026, 12:00:01 PM</td>
</tr>
`;

const tenantPayload = JSON.stringify({
  id: "msg_001",
  eventType: "user.created",
  payload: { id: 42, email: "user@example.com", name: "Jane Doe" }
}, null, 2);

let tenantDetailsHtml = tenantHtml
  .replace(`<tbody id="message-rows">${tenantMessages}</tbody>`, `<tbody id="message-rows">${tenantSelectedMessages}</tbody>`)
  .replace('<tbody id="delivery-rows"></tbody>', `<tbody id="delivery-rows">${tenantDeliveries}</tbody>`)
  .replace('<tbody id="attempt-rows"></tbody>', `<tbody id="attempt-rows">${tenantAttempts}</tbody>`)
  .replace('<pre id="message-payload">{}</pre>', `<pre id="message-payload">${tenantPayload}</pre>`)
  .replace('id="message-status" class="status" data-state="empty">Select a message.', 'id="message-status" class="status" data-state="success">2 delivery tasks.')
  .replace('id="attempt-status" class="status" data-state="empty">Select a message.', 'id="attempt-status" class="status" data-state="success">1 attempt.')
  .replace('<details class="details" style="margin-top:12px">', '<details class="details" style="margin-top:12px" open>');

tenantDetailsHtml = tenantDetailsHtml.replace(/<script>[\s\S]*?<\/script>/g, '');
writeFileSync(join(OUTPUT_DIR, 'tenant-dashboard-details.html'), tenantDetailsHtml);

// 4. Find Browser Binary
let browserPath = '';
if (process.platform === 'win32') {
  const chromePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  const edgePath = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  if (existsSync(chromePath)) {
    browserPath = chromePath;
  } else if (existsSync(edgePath)) {
    browserPath = edgePath;
  }
} else if (process.platform === 'darwin') {
  const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(chromePath)) {
    browserPath = chromePath;
  }
} else {
  // Linux or POSIX
  const candidates = ['google-chrome', 'chrome', 'microsoft-edge-stable'];
  for (const candidate of candidates) {
    try {
      const path = execSync(`which ${candidate}`, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (path) {
        browserPath = path;
        break;
      }
    } catch {
      // Ignore
    }
  }
}

if (!browserPath) {
  console.log('No suitable browser (Google Chrome or Microsoft Edge) was found on this system. Failing gracefully.');
  process.exit(0);
}

const capture = (filename: string) => {
  const htmlPath = join(OUTPUT_DIR, `${filename}.html`);
  const pngPath = join(OUTPUT_DIR, `${filename}.png`);
  console.log(`[visuals] Generating ${filename}.png from ${filename}.html using ${browserPath}`);
  
  execSync(
    `"${browserPath}" --headless --disable-gpu --no-sandbox --screenshot="${pngPath}" --window-size=1280,1024 "file:///${htmlPath}"`,
    { stdio: 'inherit' }
  );
};

capture('admin-dashboard');
capture('tenant-dashboard');
capture('tenant-dashboard-details');

console.log(`[visuals] Generation complete. Files saved in ${OUTPUT_DIR}/`);
