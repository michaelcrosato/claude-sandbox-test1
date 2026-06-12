import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * update-state.ts — the ONLY writer for roadmap/features.json (plan §4.2).
 * A PreToolUse hook blocks direct edits; CI re-validates on every PR.
 *
 * Usage:
 *   ts-node scripts/update-state.ts --validate
 *   ts-node scripts/update-state.ts --add '<feature-json>'
 *   ts-node scripts/update-state.ts --status F-0001 in_progress|pending|blocked|done [reason]
 *   ts-node scripts/update-state.ts --attempt F-0001
 *   ts-node scripts/update-state.ts --evidence F-0001 <path> [<path>...]
 *   ts-node scripts/update-state.ts --passes F-0001 true
 *   ts-node scripts/update-state.ts --paths F-0001 '<json-string-array>'   (replace authorized_paths — groom corrections)
 */

// STATE_FILE override exists for contract tests (scripts/test-hooks.sh) so they
// can exercise mutations against a fixture without touching the real backlog.
const FILE = process.env.STATE_FILE
  ? path.resolve(process.env.STATE_FILE)
  : path.join(process.cwd(), 'roadmap', 'features.json');
const STATUSES = ['pending', 'in_progress', 'blocked', 'done'];
const REQUIRED = [
  'id', 'epic', 'title', 'spec_ref', 'description', 'acceptance',
  'authorized_paths', 'forbidden_paths', 'priority', 'status', 'passes',
  'evidence', 'attempts', 'blocked_reason'
];

interface Feature {
  id: string; epic: string; title: string; spec_ref: string; description: string;
  acceptance: string[]; authorized_paths: string[]; forbidden_paths: string[];
  dependencies?: string[]; priority: number; status: string; passes: boolean;
  evidence: string[]; attempts: number; blocked_reason: string | null;
}

function fail(msg: string): never {
  console.error(`[update-state] ERROR: ${msg}`);
  process.exit(1);
}

function load(): { $schema?: string; features: Feature[] } {
  if (!fs.existsSync(FILE)) fail(`${FILE} not found`);
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    fail(`features file is not valid JSON: ${e}`);
  }
}

function save(data: { features: Feature[] }): void {
  const errors = validate(data.features);
  if (errors.length) fail(`refusing to save invalid state:\n  - ${errors.join('\n  - ')}`);
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, FILE);
  console.log('[update-state] saved.');
}

function validate(features: Feature[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const f of features) {
    for (const key of REQUIRED) {
      if (!(key in (f as unknown as Record<string, unknown>))) errors.push(`${f.id ?? '?'}: missing field "${key}"`);
    }
    if (!/^F-\d{4}$/.test(f.id)) errors.push(`invalid id "${f.id}" (want F-XXXX)`);
    if (ids.has(f.id)) errors.push(`duplicate id ${f.id}`);
    ids.add(f.id);
    if (!STATUSES.includes(f.status)) errors.push(`${f.id}: invalid status "${f.status}"`);
    if (!Number.isInteger(f.priority) || f.priority < 1 || f.priority > 3) errors.push(`${f.id}: priority must be 1..3`);
    if (!Array.isArray(f.acceptance) || f.acceptance.length === 0) errors.push(`${f.id}: needs at least one acceptance criterion`);
    if (f.attempts < 0) errors.push(`${f.id}: attempts < 0`);
    if (f.status === 'blocked' && !f.blocked_reason) errors.push(`${f.id}: blocked without blocked_reason`);
    if (f.passes && f.evidence.length === 0) errors.push(`${f.id}: passes:true with no evidence (default-FAIL contract)`);
    if (f.status === 'done' && !f.passes) errors.push(`${f.id}: status:done requires passes:true (evidence-gated flow)`);
  }
  for (const f of features) {
    for (const dep of f.dependencies ?? []) {
      if (!ids.has(dep)) errors.push(`${f.id}: dependency ${dep} does not exist`);
      if (dep === f.id) errors.push(`${f.id}: depends on itself`);
    }
  }
  // Dependency cycle detection (DFS with three colors)
  const deps = new Map(features.map((f) => [f.id, f.dependencies ?? []]));
  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, trail: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      errors.push(`dependency cycle: ${[...trail, id].join(' -> ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const d of deps.get(id) ?? []) if (deps.has(d)) walk(d, [...trail, id]);
    state.set(id, 'done');
  };
  for (const f of features) walk(f.id, []);
  return errors;
}

function find(data: { features: Feature[] }, id: string): Feature {
  const f = data.features.find((x) => x.id === id);
  if (!f) fail(`feature ${id} not found`);
  return f;
}

/** Evidence contract: every evidence file exists, is non-empty, and at least
 *  one is a verify log proving a green gate run (plan §4.2, §6.3). Used by
 *  --passes at flip time AND by --validate for every passing feature, so a
 *  hand-edited or bash-redirected passes:true cannot survive CI. */
function collectEvidenceErrors(f: Feature): string[] {
  const errors: string[] = [];
  if (f.evidence.length === 0) return [`${f.id}: no evidence recorded; run --evidence first`];
  let hasGreenVerifyLog = false;
  for (const rel of f.evidence) {
    const p = path.join(process.cwd(), rel);
    if (!fs.existsSync(p)) {
      errors.push(`${f.id}: evidence file missing on disk: ${rel}`);
      continue;
    }
    const stat = fs.statSync(p);
    if (stat.isFile() && stat.size === 0) errors.push(`${f.id}: evidence file is empty: ${rel}`);
    if (/verify.*\.log$/i.test(rel)) {
      const content = fs.readFileSync(p, 'utf8');
      // Exact-line match, not substring: a failed run's log QUOTES the marker
      // inside this very audit's error message, which once self-satisfied the
      // check (found via PR #14). A quoted occurrence is never a whole line.
      if (content.split(/\r?\n/).some((l) => l.trim() === 'VERIFY: PASS (exit 0)')) hasGreenVerifyLog = true;
    }
  }
  if (!hasGreenVerifyLog) {
    errors.push(`${f.id}: no green verify log among evidence (need a *verify*.log containing "VERIFY: PASS (exit 0)" from scripts/verify.sh)`);
  }
  return errors;
}

const [, , cmd, ...args] = process.argv;
const data = load();

switch (cmd) {
  case '--validate': {
    const errors = validate(data.features);
    // Deep evidence audit: re-verify the physical evidence contract for every
    // feature claiming passes:true, not just at flip time.
    for (const f of data.features.filter((x) => x.passes)) {
      errors.push(...collectEvidenceErrors(f));
    }
    // Model-policy freshness (F-0009): warn — never fail — when a tier's
    // last_verified exceeds 30 days, so the next session's /research runs.
    // A scheduled auto-PR cron was deliberately rejected (DECISIONS 2026-06-10).
    const policyFile = process.env.MODEL_POLICY_FILE
      ? path.resolve(process.env.MODEL_POLICY_FILE)
      : path.join(process.cwd(), '.claude', 'model-policy.json');
    if (fs.existsSync(policyFile)) {
      try {
        const policy = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
        const now = Date.now();
        for (const [tier, cfg] of Object.entries(policy.tiers ?? {})) {
          const stamp = (cfg as { last_verified?: string }).last_verified;
          const parsed = stamp ? Date.parse(stamp) : Number.NaN;
          if (Number.isNaN(parsed) || now - parsed > 30 * 24 * 3600 * 1000) {
            console.warn(`[update-state] WARN: model-policy tier "${tier}" last_verified is stale (>30d or missing) — run /research to re-verify the mapping.`);
          }
        }
      } catch {
        console.warn('[update-state] WARN: model-policy.json unreadable — run /research.');
      }
    }
    // Session metrics integrity (F-0010): roadmap/metrics.jsonl is consumed by
    // /kaizen and /status — a malformed record fails validation.
    const metricsFile = process.env.METRICS_FILE
      ? path.resolve(process.env.METRICS_FILE)
      : path.join(process.cwd(), 'roadmap', 'metrics.jsonl');
    if (fs.existsSync(metricsFile)) {
      const recordLines = fs.readFileSync(metricsFile, 'utf8').split(/\r?\n/).filter((l) => l.trim());
      recordLines.forEach((l, idx) => {
        // Bounded-injection rule (plan §9): metrics feed /kaizen and /status
        // context, so an oversized record is a prompt-injection channel.
        if (l.length > 500) {
          errors.push(`metrics.jsonl line ${idx + 1}: record exceeds 500 chars (bounded-injection rule)`);
          return;
        }
        try {
          const rec = JSON.parse(l);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(rec.date ?? '')) errors.push(`metrics.jsonl line ${idx + 1}: missing/invalid "date" (YYYY-MM-DD)`);
          if (typeof rec.feature !== 'string' || !rec.feature) errors.push(`metrics.jsonl line ${idx + 1}: missing "feature"`);
        } catch {
          errors.push(`metrics.jsonl line ${idx + 1}: not valid JSON`);
        }
      });
    }
    if (errors.length) fail(`invalid backlog:\n  - ${errors.join('\n  - ')}`);
    console.log(`[update-state] valid: ${data.features.length} features, ` +
      `${data.features.filter((f) => f.passes).length} passing (evidence re-verified).`);
    break;
  }
  case '--add': {
    if (!args[0]) fail('--add requires a JSON argument');
    let incoming: Partial<Feature>;
    try { incoming = JSON.parse(args[0]); } catch (e) { fail(`--add argument is not valid JSON: ${e}`); }
    const feature: Feature = {
      dependencies: [], status: 'pending', passes: false, evidence: [],
      attempts: 0, blocked_reason: null, forbidden_paths: ['.claude/**', '.github/workflows/**'],
      ...incoming
    } as Feature;
    // Reserved fixture range (kaizen 2026-06-11): contract tests use F-9xxx ids,
    // so a writer call that escapes its STATE_FILE fixture fails loudly here
    // instead of silently planting fixture rows in the real backlog (incident
    // found on PR #24: fixture mutations leaked into the live features.json).
    if (!process.env.STATE_FILE && /^F-9\d{3}$/.test(feature.id ?? '')) {
      fail(`${feature.id} is in the reserved contract-test fixture range (F-9xxx); it cannot be added to the real backlog`);
    }
    if (feature.passes) fail('new features are born failing (default-FAIL contract); cannot --add with passes:true');
    data.features.push(feature);
    save(data);
    break;
  }
  case '--status': {
    const [id, status, ...reason] = args;
    if (!id || !status) fail('--status requires <id> <status>');
    const f = find(data, id);
    f.status = status;
    f.blocked_reason = status === 'blocked' ? (reason.join(' ') || 'unspecified') : null;
    save(data);
    break;
  }
  case '--attempt': {
    const f = find(data, args[0]);
    f.attempts += 1;
    console.log(`[update-state] ${f.id} attempts = ${f.attempts}${f.attempts >= 2 ? ' (two-strike limit reached — block and move on)' : ''}`);
    save(data);
    break;
  }
  case '--evidence': {
    const [id, ...paths] = args;
    if (!id || paths.length === 0) fail('--evidence requires <id> <path> [...]');
    const f = find(data, id);
    for (const p of paths) {
      if (!fs.existsSync(path.join(process.cwd(), p))) fail(`evidence file does not exist: ${p}`);
      if (!f.evidence.includes(p)) f.evidence.push(p);
    }
    save(data);
    break;
  }
  case '--paths': {
    const [id, json] = args;
    if (!id || !json) fail('--paths requires <id> <json-string-array>');
    let parsed: unknown;
    try { parsed = JSON.parse(json); } catch (e) { fail(`--paths argument is not valid JSON: ${e}`); }
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === 'string' && p.length > 0)) {
      fail('--paths requires a non-empty JSON array of glob strings');
    }
    const paths = parsed as string[];
    // Scope-rewrite hardening (security review, PR #16): rescoping must never
    // be able to grant a feature the guardrail surfaces, no matter what the
    // current scope says. Guardrail edits are factory work with their own PRs.
    const GUARD_SURFACES = /^(\.claude|\.github|scripts)(\/|$)/;
    const BROAD = new Set(['*', '**', '**/*', '**/**', './**', '/**']);
    for (const p of paths) {
      if (p.includes('..')) fail(`--paths rejects parent-traversal glob: "${p}"`);
      if (BROAD.has(p.trim())) fail(`--paths rejects catch-all glob "${p}" — scope must be explicit`);
      if (GUARD_SURFACES.test(p.trim())) fail(`--paths rejects guardrail surface "${p}" (.claude/, .github/, scripts/ are never feature scope)`);
    }
    const f = find(data, id);
    if (f.status !== 'pending' && f.status !== 'in_progress') fail(`${f.id}: can only rescope pending/in_progress features (status: ${f.status})`);
    for (const p of paths) {
      if ((f.forbidden_paths ?? []).some((fp) => fp === p || (fp.endsWith('/**') && p.startsWith(fp.slice(0, -2))))) {
        fail(`${f.id}: "${p}" collides with the feature's own forbidden_paths`);
      }
    }
    f.authorized_paths = paths;
    save(data);
    break;
  }
  case '--passes': {
    const [id, value] = args;
    if (value !== 'true') fail('--passes only accepts "true" (features are born failing; to un-pass, fix the feature)');
    const f = find(data, id);
    const evidenceErrors = collectEvidenceErrors(f);
    if (evidenceErrors.length) fail(evidenceErrors.join('\n  - '));
    f.passes = true;
    save(data);
    break;
  }
  default:
    fail(`unknown command "${cmd ?? ''}". See header comment for usage.`);
}
