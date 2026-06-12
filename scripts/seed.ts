/**
 * seed.ts — deterministic synthetic seed data for manual QA and E2E runs (plan §3, §7.1).
 *
 * Rules that survive any stack (apply to the delegated-to product seed script too):
 *  - Synthetic data only — never copies of live customer data (compliance boundary, plan §6.2).
 *  - Deterministic — same input every run, so QA scripts and E2E assertions can use exact values.
 *  - Idempotent — re-running resets to the same state; safe on dev/ephemeral databases only.
 *  - Refuses production — bail if the connection target looks like prod.
 *
 * Shim contract (four branches, in order):
 *  1. Prod-refusal guard — DATABASE_URL matches /prod/i → exit 1 immediately.
 *  2. Delegation — package.json defines a non-empty "seed" script → npm run --silent seed (with
 *     SEED_SHIM_ACTIVE=1 to detect circular re-invocation) → exit with child status.
 *  3. Product mode, no seed script — src/ exists but no seed script defined → exit 1 (E2E gate
 *     must not pass against an unseeded database).
 *  4. Template mode — no src/, no seed script → log stub message and exit 0.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// 1. Prod-refusal guard (first — before any filesystem reads).
const target = process.env.DATABASE_URL ?? '';
if (/prod/i.test(target)) {
  console.error('[seed] REFUSING: connection string looks like production.');
  process.exit(1);
}

// 2. Delegation — check whether package.json defines a "seed" script.
let seedScript: string | undefined;
try {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const val = pkg.scripts?.seed;
  if (typeof val === 'string' && val.trim() !== '') {
    seedScript = val;
  }
} catch {
  // Unreadable or missing package.json — treat as no seed script.
}

if (seedScript !== undefined) {
  // Recursion sentinel: if we are already inside a delegated npm run seed that
  // re-invokes this shim, bail immediately instead of looping.
  if (process.env.SEED_SHIM_ACTIVE === '1') {
    console.error(
      '[seed] REFUSING: circular delegation — package.json "seed" script re-invokes scripts/seed.ts.',
    );
    process.exit(1);
  }

  const res = spawnSync('npm', ['run', '--silent', 'seed'], {
    stdio: 'inherit',
    shell: process.platform === 'win32', // npm is npm.cmd on Windows
    env: { ...process.env, SEED_SHIM_ACTIVE: '1' },
  });
  process.exit(res.status ?? 1); // signal-killed / spawn error → fail
}

// 3. Product mode, no seed script — hard failure so the E2E gate cannot pass unseeded.
if (existsSync('src')) {
  console.error(
    '[seed] FAILED: product code exists but package.json defines no "seed" script — the E2E gate must not pass against an unseeded database.',
  );
  process.exit(1);
}

// 4. Template mode — no product code yet; exit 0.
console.log(
  '[seed] template stub — no product schema yet. Define a "seed" script in package.json when the data layer lands (Phase 2).',
);
process.exit(0);
