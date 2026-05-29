// Compiled-dist smoke: plan catalog + entitlements through production ESM.
import { InMemoryAppStore } from "../dist/apps/in-memory-app-store.js";
import { SqliteAppStore } from "../dist/apps/sqlite-app-store.js";
import { PLAN_CATALOG, entitlementsForPlan } from "../dist/apps/plan.js";
import { buildOpenApiDocument } from "../dist/http/openapi.js";
import { PosthornAdminClient } from "../dist/sdk/admin-client.js";
import { createGateway } from "../dist/runtime/gateway.js";

let passed = 0;
function check(label, cond) {
  if (!cond) { console.error(`FAIL: ${label}`); process.exit(1); }
  console.log(`✓ ${label}`);
  passed++;
}

// ── 1. In-memory: default null, stamping, explicit override ──────────────────
const mem = new InMemoryAppStore();

const custom = await mem.create({ name: "custom" });
check("in-memory: plan defaults to null (custom/unmanaged)", custom.plan === null);
check("in-memory: custom plan leaves quota unlimited", custom.monthlyMessageQuota === null);

const pro = await mem.create({ name: "pro", plan: "pro" });
check("in-memory: assigning a plan persists the label", pro.plan === "pro");
check("in-memory: assigning a plan stamps the catalog quota",
  pro.monthlyMessageQuota === PLAN_CATALOG.pro.monthlyMessageQuota);

const override = await mem.create({ plan: "scale", monthlyMessageQuota: 7 });
check("in-memory: explicit quota overrides the plan's stamped value",
  override.plan === "scale" && override.monthlyMessageQuota === 7);

// ── 2. SQLite: round-trip, re-stamp on update, null-clear keeps quota ─────────
const db = new SqliteAppStore({ location: ":memory:" });
const dbApp = await db.create({ name: "sqlite", plan: "free" });
const fetched = await db.get(dbApp.id);
check("sqlite: plan survives a round-trip", fetched.plan === "free");
check("sqlite: stamped quota survives a round-trip",
  fetched.monthlyMessageQuota === PLAN_CATALOG.free.monthlyMessageQuota);

const upgraded = await db.update(dbApp.id, { plan: "scale" });
check("sqlite: reassigning a plan re-stamps the new tier's quota",
  upgraded.monthlyMessageQuota === PLAN_CATALOG.scale.monthlyMessageQuota);

const uncustomed = await db.update(dbApp.id, { plan: null });
check("sqlite: clearing the plan to null drops the label", uncustomed.plan === null);
check("sqlite: clearing the plan keeps the last-stamped quota",
  uncustomed.monthlyMessageQuota === PLAN_CATALOG.scale.monthlyMessageQuota);
db.close();

// ── 3. OpenAPI schema exposes plan + entitlements + PlanEntitlements ─────────
const doc = buildOpenApiDocument();
const appSchema = doc.components?.schemas?.App;
check("openapi: App schema has plan property", appSchema?.properties?.plan !== undefined);
check("openapi: App schema has entitlements property", appSchema?.properties?.entitlements !== undefined);
check("openapi: plan is in App.required[]", appSchema?.required?.includes("plan") === true);
check("openapi: entitlements is in App.required[]", appSchema?.required?.includes("entitlements") === true);
check("openapi: PlanEntitlements schema is defined", doc.components?.schemas?.PlanEntitlements !== undefined);

// ── 4. Running gateway: provision a tier via admin SDK → entitlements view ────
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

const gwCustom = await admin.createApp({ name: "Custom" });
check("gateway: custom tenant has null plan + null entitlements",
  gwCustom.plan === null && gwCustom.entitlements === null);

const gwPro = await admin.createApp({ name: "Pro", plan: "pro" });
check("gateway: created tenant carries the plan label", gwPro.plan === "pro");
check("gateway: entitlements resolved in the view match the catalog",
  gwPro.entitlements?.monthlyMessageQuota === entitlementsForPlan("pro").monthlyMessageQuota);
check("gateway: stamped quota equals the plan's entitlement quota",
  gwPro.monthlyMessageQuota === gwPro.entitlements?.monthlyMessageQuota);

const gwScaled = await admin.updateApp(gwPro.id, { plan: "scale" });
check("gateway: PATCH re-stamps the upgraded tier's quota",
  gwScaled.monthlyMessageQuota === PLAN_CATALOG.scale.monthlyMessageQuota);
check("gateway: upgraded quota is strictly larger", gwScaled.monthlyMessageQuota > gwPro.monthlyMessageQuota);

await gw.stop();

console.log(`\nAll ${passed} smoke checks PASS ✓`);
