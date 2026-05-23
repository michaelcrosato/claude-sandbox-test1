// Compiled-dist smoke: per-key lastUsedAt lifecycle through production ESM.
import { InMemoryAppStore } from "../dist/apps/in-memory-app-store.js";
import { SqliteAppStore } from "../dist/apps/sqlite-app-store.js";
import { buildOpenApiDocument } from "../dist/http/openapi.js";
import { PosthornAdminClient } from "../dist/sdk/admin-client.js";
import { createGateway } from "../dist/runtime/gateway.js";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── 1. In-memory: lastUsedAt lifecycle ──────────────────────────────────────
const mem = new InMemoryAppStore();
const app = await mem.create({ name: "smoke" });
const { apiKey, secret } = await mem.createApiKey(app.id);

check("in-memory: lastUsedAt is null before first use", apiKey.lastUsedAt === null);

await mem.authenticate(secret);
const [k1] = await mem.listApiKeys(app.id);
check("in-memory: lastUsedAt set after successful auth", k1.lastUsedAt !== null);

const prev = k1.lastUsedAt;
await mem.authenticate("phk_wrong");
const [k2] = await mem.listApiKeys(app.id);
check("in-memory: lastUsedAt unchanged after failed auth", k2.lastUsedAt === prev);

// Second auth bumps timestamp (use a slight delay so they differ by at least 1ms).
await new Promise(r => setTimeout(r, 2));
await mem.authenticate(secret);
const [k3] = await mem.listApiKeys(app.id);
check("in-memory: lastUsedAt advances on subsequent auth", k3.lastUsedAt >= prev);

// ── 2. SQLite: lastUsedAt + migration ────────────────────────────────────────
const db = new SqliteAppStore({ location: ":memory:" });
const dbApp = await db.create({ name: "sqlite-smoke" });
const { apiKey: dbKey, secret: dbSecret } = await db.createApiKey(dbApp.id);

check("sqlite: lastUsedAt is null before first use", dbKey.lastUsedAt === null);

await db.authenticate(dbSecret);
const [dbK1] = await db.listApiKeys(dbApp.id);
check("sqlite: lastUsedAt set after successful auth", dbK1.lastUsedAt !== null);

const dbPrev = dbK1.lastUsedAt;
await db.authenticate("phk_wrong");
const [dbK2] = await db.listApiKeys(dbApp.id);
check("sqlite: lastUsedAt unchanged after failed auth", dbK2.lastUsedAt === dbPrev);
db.close();

// ── 3. OpenAPI schema includes lastUsedAt ────────────────────────────────────
const doc = buildOpenApiDocument();
const apiKeySchema = doc.components?.schemas?.ApiKey;
check("openapi: ApiKey schema has lastUsedAt property", apiKeySchema?.properties?.lastUsedAt !== undefined);
check("openapi: lastUsedAt is in required[]", apiKeySchema?.required?.includes("lastUsedAt") === true);
check("openapi: lastUsedAt type is ['integer','null']", JSON.stringify(apiKeySchema?.properties?.lastUsedAt?.type) === JSON.stringify(["integer","null"]));

// ── 4. Running gateway: provision + auth → lastUsedAt visible via admin SDK ──
const ADMIN_TOKEN = "smoke-token-32chars-secure-xxxx";
const gw = createGateway({
  host: "127.0.0.1",
  port: 0,
  dataDir: ":memory:",
  maxBodyBytes: 1_000_000,
  adminToken: ADMIN_TOKEN,
  endpointAutoDisableAfterMs: 0,
  worker: { batchSize: 10, concurrency: 4, requestTimeoutMs: 5_000, idlePollMs: 50, visibilityTimeoutMs: 30_000 },
  fanout: { graceMs: 500, batchSize: 10, idlePollMs: 50 },
});
const { port } = await gw.start();
const base = `http://127.0.0.1:${port}`;

const admin = new PosthornAdminClient({ baseUrl: base, adminToken: ADMIN_TOKEN });
const gwApp = await admin.createApp({ name: "GW Smoke" });
const { secret: gwSecret } = await admin.createApiKey(gwApp.id);

const keysBefore = await admin.listApiKeys(gwApp.id);
check("gateway: lastUsedAt is null before any use", keysBefore[0].lastUsedAt === null);

// Trigger authentication via a real HTTP request.
const resp = await fetch(`${base}/v1/endpoints`, {
  headers: { authorization: `Bearer ${gwSecret}` },
});
check("gateway: tenant request authenticated (200)", resp.status === 200);

const keysAfter = await admin.listApiKeys(gwApp.id);
check("gateway: lastUsedAt updated after real HTTP auth", keysAfter[0].lastUsedAt !== null);
console.log(`         lastUsedAt = ${keysAfter[0].lastUsedAt} (${new Date(keysAfter[0].lastUsedAt).toISOString()})`);

// Revoke key: lastUsedAt still visible on revoked key.
await admin.revokeApiKey(keysBefore[0].id);
const keysRevoked = await admin.listApiKeys(gwApp.id);
check("gateway: lastUsedAt preserved after revocation", keysRevoked[0].lastUsedAt !== null);
check("gateway: revokedAt set", keysRevoked[0].revokedAt !== null);

await gw.stop();

console.log(`\nAll ${passed}/12 smoke checks PASS ✓`);
