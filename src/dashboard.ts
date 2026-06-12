export function renderAdminDashboardPage(): string {
  return dashboardDocument({
    title: 'Posthorn Admin',
    active: 'admin',
    body: adminBody(),
    script: adminScript(),
  });
}

export function renderTenantDashboardPage(): string {
  return dashboardDocument({
    title: 'Posthorn Tenant',
    active: 'tenant',
    body: tenantBody(),
    script: tenantScript(),
  });
}

function dashboardDocument(options: {
  readonly title: string;
  readonly active: 'admin' | 'tenant';
  readonly body: string;
  readonly script: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${options.title}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fb;
      --ink: #172033;
      --muted: #5e6678;
      --line: #d7dce6;
      --panel: #ffffff;
      --primary: #1f6feb;
      --primary-ink: #ffffff;
      --danger: #b42318;
      --success: #067647;
      --warning: #946200;
      --focus: #7c3aed;
      font-family: Arial, Helvetica, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-width: 320px;
      background: var(--bg);
      color: var(--ink);
      font-size: 14px;
      line-height: 1.45;
    }
    a { color: var(--primary); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .topbar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      min-height: 64px;
      padding: 0 24px;
      border-bottom: 1px solid var(--line);
      background: #ffffff;
      position: sticky;
      top: 0;
      z-index: 2;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 18px;
      letter-spacing: 0;
      white-space: nowrap;
    }
    .brand-mark {
      width: 28px;
      height: 28px;
      display: inline-grid;
      place-items: center;
      border-radius: 6px;
      background: var(--ink);
      color: #ffffff;
      font-size: 14px;
    }
    nav {
      display: flex;
      align-items: center;
      gap: 6px;
      flex-wrap: wrap;
      justify-content: flex-end;
    }
    nav a {
      min-height: 36px;
      display: inline-flex;
      align-items: center;
      border: 1px solid transparent;
      border-radius: 6px;
      padding: 0 12px;
      color: var(--muted);
      font-weight: 600;
    }
    nav a[aria-current="page"] {
      border-color: var(--line);
      background: #f2f5fa;
      color: var(--ink);
    }
    main {
      width: min(1440px, 100%);
      margin: 0 auto;
      padding: 20px 24px 32px;
    }
    .page-head {
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
      margin-bottom: 18px;
    }
    h1 {
      margin: 0;
      font-size: 24px;
      letter-spacing: 0;
    }
    h2 {
      margin: 0 0 12px;
      font-size: 16px;
      letter-spacing: 0;
    }
    .grid {
      display: grid;
      grid-template-columns: minmax(280px, 360px) minmax(0, 1fr);
      gap: 18px;
      align-items: start;
    }
    .stack { display: grid; gap: 18px; }
    section {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 16px;
      min-width: 0;
    }
    form, .controls {
      display: grid;
      gap: 12px;
    }
    label {
      display: grid;
      gap: 6px;
      color: var(--muted);
      font-weight: 600;
    }
    input, select {
      width: 100%;
      min-height: 38px;
      border: 1px solid #b9c0cc;
      border-radius: 6px;
      padding: 8px 10px;
      color: var(--ink);
      background: #ffffff;
      font: inherit;
    }
    input:focus, select:focus, button:focus-visible {
      outline: 3px solid rgba(124, 58, 237, 0.2);
      outline-offset: 1px;
      border-color: var(--focus);
    }
    button {
      min-height: 38px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 8px 12px;
      background: #ffffff;
      color: var(--ink);
      font: inherit;
      font-weight: 700;
      cursor: pointer;
    }
    button:hover { border-color: #98a2b3; }
    button.primary {
      border-color: var(--primary);
      background: var(--primary);
      color: var(--primary-ink);
    }
    button.danger {
      border-color: #fecdca;
      color: var(--danger);
    }
    button:disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }
    .row {
      display: flex;
      gap: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    .row > * { flex: 1 1 160px; }
    .row > button { flex: 0 0 auto; }
    .status {
      min-height: 34px;
      display: flex;
      align-items: center;
      border-radius: 6px;
      border: 1px solid var(--line);
      background: #f8fafc;
      color: var(--muted);
      padding: 8px 10px;
      overflow-wrap: anywhere;
    }
    .status[data-state="success"] {
      color: var(--success);
      background: #ecfdf3;
      border-color: #abefc6;
    }
    .status[data-state="error"] {
      color: var(--danger);
      background: #fef3f2;
      border-color: #fecdca;
    }
    .status[data-state="loading"] {
      color: var(--warning);
      background: #fffaeb;
      border-color: #fedf89;
    }
    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      min-width: 680px;
      background: #ffffff;
    }
    th, td {
      text-align: left;
      border-bottom: 1px solid var(--line);
      padding: 10px;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      background: #f8fafc;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0;
    }
    tr:last-child td { border-bottom: 0; }
    tr.selected td { background: #eef4ff; }
    .mono {
      font-family: "Courier New", monospace;
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .pill {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      border-radius: 999px;
      padding: 2px 8px;
      background: #eef2f6;
      color: #344054;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .pill.success { background: #dcfae6; color: var(--success); }
    .pill.error { background: #fee4e2; color: var(--danger); }
    .secret {
      display: none;
      border: 1px solid #abefc6;
      border-radius: 8px;
      background: #ecfdf3;
      padding: 12px;
      overflow-wrap: anywhere;
    }
    .secret[data-visible="true"] { display: block; }
    .details {
      display: grid;
      gap: 12px;
    }
    pre {
      margin: 0;
      max-height: 280px;
      overflow: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: #101828;
      color: #f9fafb;
      padding: 12px;
      font-size: 12px;
    }
    @media (max-width: 860px) {
      .topbar {
        align-items: flex-start;
        flex-direction: column;
        padding: 14px 16px;
      }
      nav { justify-content: flex-start; }
      main { padding: 16px; }
      .page-head { align-items: flex-start; flex-direction: column; }
      .grid { grid-template-columns: 1fr; }
      table { min-width: 560px; }
    }
  </style>
</head>
<body>
  <header class="topbar">
    <div class="brand"><span class="brand-mark">P</span><span>Posthorn</span></div>
    <nav aria-label="Dashboard">
      <a href="/dashboard"${options.active === 'admin' ? ' aria-current="page"' : ''}>Admin</a>
      <a href="/dashboard/tenant"${options.active === 'tenant' ? ' aria-current="page"' : ''}>Tenant</a>
      <a href="/openapi.json">OpenAPI</a>
    </nav>
  </header>
  <main>
    ${options.body}
  </main>
  <script>${sharedScript()}</script>
  <script>${options.script}</script>
</body>
</html>`;
}

function adminBody(): string {
  return `
    <div class="page-head">
      <h1>Admin Dashboard</h1>
      <button id="refresh-admin" class="primary" type="button">Refresh</button>
    </div>
    <div class="grid">
      <div class="stack">
        <section>
          <h2>Admin Session</h2>
          <form id="admin-auth-form">
            <label>Admin token
              <input id="admin-token" name="adminToken" type="password" autocomplete="current-password" required>
            </label>
            <button class="primary" type="submit">Connect</button>
          </form>
          <p id="admin-auth-status" class="status" data-state="empty">Waiting for admin token.</p>
        </section>
        <section>
          <h2>Create Tenant</h2>
          <form id="create-tenant-form">
            <label>Tenant name
              <input id="tenant-name" name="name" autocomplete="off" required>
            </label>
            <label>Monthly message quota
              <input id="tenant-quota" name="monthlyMessageQuota" type="number" min="0" step="1" placeholder="Unlimited">
            </label>
            <button class="primary" type="submit">Create Tenant</button>
          </form>
          <p id="create-tenant-status" class="status" data-state="empty">No tenant created yet.</p>
        </section>
        <section>
          <h2>API Key</h2>
          <form id="create-key-form">
            <label>Key name
              <input id="key-name" name="name" autocomplete="off" placeholder="Primary key">
            </label>
            <button class="primary" type="submit">Mint Key</button>
          </form>
          <div id="created-secret" class="secret" data-visible="false">
            <div class="pill success">Shown once</div>
            <p class="mono" id="created-secret-value"></p>
          </div>
          <p id="create-key-status" class="status" data-state="empty">Select a tenant.</p>
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Tenants</h2>
          <p id="tenant-list-status" class="status" data-state="empty">No request sent.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Tenant</th>
                  <th>Quota</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="tenant-rows"></tbody>
            </table>
          </div>
        </section>
        <section>
          <h2>Usage</h2>
          <p id="usage-status" class="status" data-state="empty">Select a tenant.</p>
          <div id="usage-summary" class="row"></div>
        </section>
        <section>
          <h2>Keys</h2>
          <p id="key-list-status" class="status" data-state="empty">Select a tenant.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Key</th>
                  <th>Name</th>
                  <th>Created</th>
                  <th>Revoked</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="key-rows"></tbody>
            </table>
          </div>
        </section>
      </div>
    </div>`;
}

function tenantBody(): string {
  return `
    <div class="page-head">
      <h1>Tenant Dashboard</h1>
      <button id="refresh-tenant" class="primary" type="button">Refresh</button>
    </div>
    <div class="grid">
      <div class="stack">
        <section>
          <h2>Tenant Session</h2>
          <form id="tenant-auth-form">
            <label>API key
              <input id="tenant-key" name="apiKey" type="password" autocomplete="current-password" required>
            </label>
            <button class="primary" type="submit">Connect</button>
          </form>
          <p id="tenant-auth-status" class="status" data-state="empty">Waiting for API key.</p>
        </section>
        <section>
          <h2>Usage</h2>
          <p id="tenant-usage-status" class="status" data-state="empty">No request sent.</p>
          <div id="tenant-usage-summary" class="row"></div>
        </section>
        <section>
          <h2>Endpoints</h2>
          <p id="endpoint-status" class="status" data-state="empty">No request sent.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Endpoint</th>
                  <th>Events</th>
                  <th>Enabled</th>
                </tr>
              </thead>
              <tbody id="endpoint-rows"></tbody>
            </table>
          </div>
        </section>
      </div>
      <div class="stack">
        <section>
          <h2>Message History</h2>
          <p id="message-list-status" class="status" data-state="empty">No request sent.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Message</th>
                  <th>Event</th>
                  <th>Created</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="message-rows"></tbody>
            </table>
          </div>
          <div class="row" style="margin-top:12px">
            <button id="load-more-messages" type="button" disabled>Load More</button>
          </div>
        </section>
        <section>
          <h2>Delivery Status</h2>
          <p id="message-status" class="status" data-state="empty">Select a message.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Delivery</th>
                  <th>Endpoint</th>
                  <th>Status</th>
                  <th>Attempts</th>
                </tr>
              </thead>
              <tbody id="delivery-rows"></tbody>
            </table>
          </div>
        </section>
        <section>
          <h2>Attempt Audit Log</h2>
          <p id="attempt-status" class="status" data-state="empty">Select a message.</p>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Attempt</th>
                  <th>Outcome</th>
                  <th>HTTP</th>
                  <th>Reason</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody id="attempt-rows"></tbody>
            </table>
          </div>
          <details class="details" style="margin-top:12px">
            <summary>Payload</summary>
            <pre id="message-payload">{}</pre>
          </details>
        </section>
      </div>
    </div>`;
}

function sharedScript(): string {
  return `
const ph = (() => {
  function byId(id) {
    const element = document.getElementById(id);
    if (!element) throw new Error('Missing element: ' + id);
    return element;
  }
  function clear(element) {
    while (element.firstChild) element.removeChild(element.firstChild);
  }
  function cell(value, className) {
    const td = document.createElement('td');
    if (className) td.className = className;
    td.textContent = value == null ? '' : String(value);
    return td;
  }
  function button(label, className) {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = label;
    if (className) control.className = className;
    return control;
  }
  function setStatus(id, state, text) {
    const element = byId(id);
    element.dataset.state = state;
    element.textContent = text;
  }
  function errorMessage(error) {
    if (error && typeof error.message === 'string') return error.message;
    return 'Request failed.';
  }
  async function api(path, token, options = {}) {
    const headers = {
      authorization: 'Bearer ' + token,
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' })
    };
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : null;
    if (!response.ok) {
      const code = body && body.error && body.error.code ? body.error.code : response.status;
      const message = body && body.error && body.error.message ? body.error.message : response.statusText;
      throw new Error(code + ': ' + message);
    }
    return body;
  }
  function formatDate(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
  }
  function pill(value, ok) {
    const span = document.createElement('span');
    span.className = 'pill' + (ok === true ? ' success' : ok === false ? ' error' : '');
    span.textContent = value == null ? '' : String(value);
    return span;
  }
  function metric(label, value) {
    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<span class="pill"></span><div class="mono"></div>';
    wrapper.querySelector('.pill').textContent = label;
    wrapper.querySelector('.mono').textContent = value == null ? '' : String(value);
    return wrapper;
  }
  return { byId, clear, cell, button, setStatus, errorMessage, api, formatDate, pill, metric };
})();`;
}

function adminScript(): string {
  return `
(() => {
  let token = '';
  let selectedApp = null;
  let tenants = [];

  const authForm = ph.byId('admin-auth-form');
  const createTenantForm = ph.byId('create-tenant-form');
  const createKeyForm = ph.byId('create-key-form');
  const refresh = ph.byId('refresh-admin');

  authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    token = ph.byId('admin-token').value.trim();
    selectedApp = null;
    void loadAdmin();
  });
  refresh.addEventListener('click', () => void loadAdmin());
  createTenantForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void createTenant();
  });
  createKeyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void createKey();
  });

  async function loadAdmin() {
    if (!token) {
      ph.setStatus('admin-auth-status', 'error', 'Admin token required.');
      return;
    }
    ph.setStatus('admin-auth-status', 'loading', 'Loading tenants...');
    ph.setStatus('tenant-list-status', 'loading', 'Loading tenants...');
    try {
      const body = await ph.api('/v1/admin/apps', token);
      tenants = body.data || [];
      if (selectedApp && !tenants.some((app) => app.id === selectedApp.id)) selectedApp = null;
      if (!selectedApp && tenants.length > 0) selectedApp = tenants[0];
      ph.setStatus('admin-auth-status', 'success', 'Connected.');
      ph.setStatus('create-key-status', selectedApp ? 'empty' : 'error', selectedApp ? 'Ready.' : 'Select a tenant.');
      renderTenants();
      if (selectedApp) await loadSelectedTenant();
    } catch (error) {
      tenants = [];
      renderTenants();
      ph.setStatus('admin-auth-status', 'error', ph.errorMessage(error));
      ph.setStatus('tenant-list-status', 'error', ph.errorMessage(error));
    }
  }

  async function createTenant() {
    if (!token) {
      ph.setStatus('create-tenant-status', 'error', 'Admin token required.');
      return;
    }
    const name = ph.byId('tenant-name').value;
    const quotaValue = ph.byId('tenant-quota').value.trim();
    const monthlyMessageQuota = quotaValue === '' ? null : Number(quotaValue);
    ph.setStatus('create-tenant-status', 'loading', 'Creating tenant...');
    try {
      const body = await ph.api('/v1/admin/apps', token, {
        method: 'POST',
        body: { name, monthlyMessageQuota }
      });
      selectedApp = body.app;
      ph.setStatus('create-tenant-status', 'success', 'Tenant created.');
      createTenantForm.reset();
      await loadAdmin();
      selectTenant(body.app.id);
    } catch (error) {
      ph.setStatus('create-tenant-status', 'error', ph.errorMessage(error));
    }
  }

  async function createKey() {
    if (!selectedApp) {
      ph.setStatus('create-key-status', 'error', 'Select a tenant.');
      return;
    }
    const name = ph.byId('key-name').value.trim();
    ph.setStatus('create-key-status', 'loading', 'Minting key...');
    try {
      const body = await ph.api('/v1/admin/apps/' + encodeURIComponent(selectedApp.id) + '/keys', token, {
        method: 'POST',
        body: name ? { name } : {}
      });
      ph.byId('created-secret-value').textContent = body.secret;
      ph.byId('created-secret').dataset.visible = 'true';
      ph.setStatus('create-key-status', 'success', 'Key created.');
      createKeyForm.reset();
      await loadKeys();
    } catch (error) {
      ph.setStatus('create-key-status', 'error', ph.errorMessage(error));
    }
  }

  function renderTenants() {
    const rows = ph.byId('tenant-rows');
    ph.clear(rows);
    if (tenants.length === 0) {
      ph.setStatus('tenant-list-status', 'empty', 'No tenants yet.');
      return;
    }
    ph.setStatus('tenant-list-status', 'success', tenants.length + ' tenant' + (tenants.length === 1 ? '' : 's') + '.');
    tenants.forEach((app) => {
      const tr = document.createElement('tr');
      if (selectedApp && selectedApp.id === app.id) tr.className = 'selected';
      tr.append(
        ph.cell(app.name + '\\n' + app.id, 'mono'),
        ph.cell(app.monthlyMessageQuota === null ? 'Unlimited' : app.monthlyMessageQuota),
        ph.cell(ph.formatDate(app.createdAt)),
      );
      const action = ph.cell('');
      const select = ph.button('Select', 'primary');
      select.addEventListener('click', () => selectTenant(app.id));
      action.append(select);
      tr.append(action);
      rows.append(tr);
    });
  }

  function selectTenant(appId) {
    selectedApp = tenants.find((app) => app.id === appId) || null;
    renderTenants();
    ph.byId('created-secret').dataset.visible = 'false';
    ph.setStatus('create-key-status', selectedApp ? 'empty' : 'error', selectedApp ? 'Ready.' : 'Select a tenant.');
    void loadSelectedTenant();
  }

  async function loadSelectedTenant() {
    await Promise.all([loadUsage(), loadKeys()]);
  }

  async function loadUsage() {
    if (!selectedApp) {
      ph.setStatus('usage-status', 'empty', 'Select a tenant.');
      ph.clear(ph.byId('usage-summary'));
      return;
    }
    ph.setStatus('usage-status', 'loading', 'Loading usage...');
    try {
      const body = await ph.api('/v1/admin/apps/' + encodeURIComponent(selectedApp.id) + '/usage', token);
      const usage = body.usage;
      const summary = ph.byId('usage-summary');
      ph.clear(summary);
      summary.append(
        ph.metric('Month', usage.month),
        ph.metric('Messages', usage.messagesAccepted),
        ph.metric('Delivery attempts', usage.deliveryAttempts),
        ph.metric('Remaining', usage.quota.remaining === null ? 'Unlimited' : usage.quota.remaining)
      );
      ph.setStatus('usage-status', 'success', selectedApp.name);
    } catch (error) {
      ph.setStatus('usage-status', 'error', ph.errorMessage(error));
    }
  }

  async function loadKeys() {
    const rows = ph.byId('key-rows');
    ph.clear(rows);
    if (!selectedApp) {
      ph.setStatus('key-list-status', 'empty', 'Select a tenant.');
      return;
    }
    ph.setStatus('key-list-status', 'loading', 'Loading keys...');
    try {
      const body = await ph.api('/v1/admin/apps/' + encodeURIComponent(selectedApp.id) + '/keys', token);
      const keys = body.data || [];
      if (keys.length === 0) {
        ph.setStatus('key-list-status', 'empty', 'No keys yet.');
        return;
      }
      ph.setStatus('key-list-status', 'success', keys.length + ' key' + (keys.length === 1 ? '' : 's') + '.');
      keys.forEach((apiKey) => {
        const tr = document.createElement('tr');
        tr.append(
          ph.cell(apiKey.id, 'mono'),
          ph.cell(apiKey.name || ''),
          ph.cell(ph.formatDate(apiKey.createdAt)),
          ph.cell(apiKey.revokedAt ? ph.formatDate(apiKey.revokedAt) : ''),
        );
        const action = ph.cell('');
        const revoke = ph.button('Revoke', 'danger');
        revoke.disabled = Boolean(apiKey.revokedAt);
        revoke.addEventListener('click', () => revokeKey(apiKey.id));
        action.append(revoke);
        tr.append(action);
        rows.append(tr);
      });
    } catch (error) {
      ph.setStatus('key-list-status', 'error', ph.errorMessage(error));
    }
  }

  async function revokeKey(keyId) {
    ph.setStatus('key-list-status', 'loading', 'Revoking key...');
    try {
      await ph.api('/v1/admin/keys/' + encodeURIComponent(keyId), token, { method: 'DELETE' });
      ph.setStatus('key-list-status', 'success', 'Key revoked.');
      await loadKeys();
    } catch (error) {
      ph.setStatus('key-list-status', 'error', ph.errorMessage(error));
    }
  }
})();`;
}

function tenantScript(): string {
  return `
(() => {
  let token = '';
  let messages = [];
  let nextCursor = null;
  let selectedMessage = null;

  const authForm = ph.byId('tenant-auth-form');
  const refresh = ph.byId('refresh-tenant');
  const loadMore = ph.byId('load-more-messages');

  authForm.addEventListener('submit', (event) => {
    event.preventDefault();
    token = ph.byId('tenant-key').value.trim();
    messages = [];
    nextCursor = null;
    selectedMessage = null;
    void loadTenant(true);
  });
  refresh.addEventListener('click', () => void loadTenant(true));
  loadMore.addEventListener('click', () => void loadMessages(false));

  async function loadTenant(resetMessages) {
    if (!token) {
      ph.setStatus('tenant-auth-status', 'error', 'API key required.');
      return;
    }
    ph.setStatus('tenant-auth-status', 'loading', 'Loading tenant data...');
    try {
      await Promise.all([loadUsage(), loadEndpoints(), loadMessages(resetMessages)]);
      ph.setStatus('tenant-auth-status', 'success', 'Connected.');
    } catch {
      ph.setStatus('tenant-auth-status', 'error', 'One or more requests failed.');
    }
  }

  async function loadUsage() {
    ph.setStatus('tenant-usage-status', 'loading', 'Loading usage...');
    try {
      const body = await ph.api('/v1/usage', token);
      const usage = body.usage;
      const summary = ph.byId('tenant-usage-summary');
      ph.clear(summary);
      summary.append(
        ph.metric('Month', usage.month),
        ph.metric('Messages', usage.messagesAccepted),
        ph.metric('Delivery attempts', usage.deliveryAttempts),
        ph.metric('Remaining', usage.quota.remaining === null ? 'Unlimited' : usage.quota.remaining)
      );
      ph.setStatus('tenant-usage-status', 'success', 'Usage loaded.');
    } catch (error) {
      ph.setStatus('tenant-usage-status', 'error', ph.errorMessage(error));
      throw error;
    }
  }

  async function loadEndpoints() {
    ph.setStatus('endpoint-status', 'loading', 'Loading endpoints...');
    const rows = ph.byId('endpoint-rows');
    ph.clear(rows);
    try {
      const body = await ph.api('/v1/endpoints', token);
      const endpoints = body.data || [];
      if (endpoints.length === 0) {
        ph.setStatus('endpoint-status', 'empty', 'No endpoints yet.');
        return;
      }
      ph.setStatus('endpoint-status', 'success', endpoints.length + ' endpoint' + (endpoints.length === 1 ? '' : 's') + '.');
      endpoints.forEach((endpoint) => {
        const tr = document.createElement('tr');
        tr.append(
          ph.cell(endpoint.id + '\\n' + endpoint.url, 'mono'),
          ph.cell(endpoint.eventTypes ? endpoint.eventTypes.join(', ') : 'All'),
          ph.cell(endpoint.enabled ? 'Yes' : 'No')
        );
        rows.append(tr);
      });
    } catch (error) {
      ph.setStatus('endpoint-status', 'error', ph.errorMessage(error));
      throw error;
    }
  }

  async function loadMessages(reset) {
    if (reset) {
      messages = [];
      nextCursor = null;
      renderMessages();
    }
    const query = nextCursor ? '?limit=25&cursor=' + encodeURIComponent(nextCursor) : '?limit=25';
    ph.setStatus('message-list-status', 'loading', 'Loading messages...');
    loadMore.disabled = true;
    try {
      const body = await ph.api('/v1/messages' + query, token);
      messages = reset ? (body.data || []) : messages.concat(body.data || []);
      nextCursor = body.nextCursor || null;
      renderMessages();
    } catch (error) {
      ph.setStatus('message-list-status', 'error', ph.errorMessage(error));
      throw error;
    }
  }

  function renderMessages() {
    const rows = ph.byId('message-rows');
    ph.clear(rows);
    if (messages.length === 0) {
      ph.setStatus('message-list-status', 'empty', 'No messages yet.');
      loadMore.disabled = true;
      return;
    }
    ph.setStatus('message-list-status', 'success', messages.length + ' message' + (messages.length === 1 ? '' : 's') + '.');
    loadMore.disabled = !nextCursor;
    messages.forEach((message) => {
      const tr = document.createElement('tr');
      if (selectedMessage && selectedMessage.id === message.id) tr.className = 'selected';
      tr.append(
        ph.cell(message.id, 'mono'),
        ph.cell(message.eventType),
        ph.cell(ph.formatDate(message.createdAt)),
      );
      const action = ph.cell('');
      const select = ph.button('Inspect', 'primary');
      select.addEventListener('click', () => selectMessage(message));
      action.append(select);
      tr.append(action);
      rows.append(tr);
    });
  }

  function selectMessage(message) {
    selectedMessage = message;
    renderMessages();
    ph.byId('message-payload').textContent = JSON.stringify(message.payload, null, 2);
    void Promise.all([loadMessageStatus(message.id), loadAttempts(message.id)]);
  }

  async function loadMessageStatus(messageId) {
    ph.setStatus('message-status', 'loading', 'Loading delivery status...');
    const rows = ph.byId('delivery-rows');
    ph.clear(rows);
    try {
      const body = await ph.api('/v1/messages/' + encodeURIComponent(messageId), token);
      if (!body.deliveries || body.deliveries.length === 0) {
        ph.setStatus('message-status', 'empty', 'No delivery tasks.');
        return;
      }
      ph.setStatus('message-status', 'success', body.deliveries.length + ' delivery task' + (body.deliveries.length === 1 ? '' : 's') + '.');
      body.deliveries.forEach((delivery) => {
        const tr = document.createElement('tr');
        tr.append(
          ph.cell(delivery.id, 'mono'),
          ph.cell(delivery.endpointId, 'mono'),
          ph.cell(delivery.status),
          ph.cell(delivery.attemptCount)
        );
        rows.append(tr);
      });
    } catch (error) {
      ph.setStatus('message-status', 'error', ph.errorMessage(error));
    }
  }

  async function loadAttempts(messageId) {
    ph.setStatus('attempt-status', 'loading', 'Loading attempts...');
    const rows = ph.byId('attempt-rows');
    ph.clear(rows);
    try {
      const body = await ph.api('/v1/messages/' + encodeURIComponent(messageId) + '/attempts?limit=50', token);
      const attempts = body.data || [];
      if (attempts.length === 0) {
        ph.setStatus('attempt-status', 'empty', 'No attempts yet.');
        return;
      }
      ph.setStatus('attempt-status', 'success', attempts.length + ' attempt' + (attempts.length === 1 ? '' : 's') + '.');
      attempts.forEach((attempt) => {
        const tr = document.createElement('tr');
        tr.append(
          ph.cell(String(attempt.attemptNumber)),
          ph.cell(attempt.outcome),
          ph.cell(attempt.responseStatus === null ? '' : attempt.responseStatus),
          ph.cell(attempt.failureReason || ''),
          ph.cell(ph.formatDate(attempt.attemptedAt))
        );
        rows.append(tr);
      });
    } catch (error) {
      ph.setStatus('attempt-status', 'error', ph.errorMessage(error));
    }
  }
})();`;
}
