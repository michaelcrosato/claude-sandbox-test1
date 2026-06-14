const fs = require('fs');
const path = require('path');

function fail(msg) {
  console.error(`BLOCKED by path-guard hook: ${msg}`);
  process.exit(2);
}

function matchGlob(filePath, glob) {
  const normPath = normalizePath(filePath);
  const normGlob = glob.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '').trim();

  if (normGlob === '**') return true;

  let regexStr = normGlob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex chars
    .replace(/\*\*\/\*/g, '.*')          // **/.* -> matches all subdirs and files
    .replace(/\*\*\//g, '(?:.*/)?')      // **/ -> matches optional subdirectories
    .replace(/\*\*/g, '.*')              // ** -> matches anything
    .replace(/\*/g, '[^/]*')             // * -> matches any non-slash chars
    .replace(/\?/g, '.');                // ? -> matches single char
  
  const regex = new RegExp('^' + regexStr + '$');
  return regex.test(normPath);
}

function normalizePath(p) {
  let relative = p;
  try {
    if (path.isAbsolute(p)) {
      relative = path.relative(process.cwd(), p);
    } else {
      relative = path.relative(process.cwd(), path.resolve(p));
    }
  } catch (e) {
    // Fallback if path resolution fails
  }
  return relative.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\.\//, '').replace(/\/$/, '').trim();
}

function run() {
  // Read stdin
  let input = '';
  try {
    input = fs.readFileSync(0, 'utf-8');
  } catch (e) {
    process.exit(0);
  }

  let filePath = '';
  try {
    const json = JSON.parse(input);
    filePath = json.tool_input?.file_path || '';
  } catch (e) {
    process.exit(0);
  }

  if (!filePath) {
    process.exit(0);
  }

  const normFile = normalizePath(filePath);

  // Load roadmap/features.json (needed for both derivation and authz lookup)
  const featuresPath = process.env.STATE_FILE
    ? path.resolve(process.env.STATE_FILE)
    : path.join(process.cwd(), 'roadmap', 'features.json');
  if (!fs.existsSync(featuresPath)) {
    process.exit(0);
  }

  let featuresData;
  try {
    featuresData = JSON.parse(fs.readFileSync(featuresPath, 'utf8'));
  } catch (e) {
    process.exit(0);
  }

  // F-0022: Derive active feature mechanically if CLAUDE_ACTIVE_FEATURE not set.
  // Precedence: env var > exactly-one-in_progress > (0 in_progress = permissive).
  // F-0025: 2+ in_progress is anomalous (the single-in_progress invariant blocks it at
  // the writer); if it occurs anyway (e.g. a hand-edit bypassing update-state) the guard
  // FAILS CLOSED instead of going permissive, closing the self-bypass vector.
  let activeFeature = process.env.CLAUDE_ACTIVE_FEATURE || '';
  if (!activeFeature) {
    const inProgress = (featuresData.features || []).filter(f => f && f.status === 'in_progress');
    if (inProgress.length === 1) {
      activeFeature = inProgress[0].id;
    } else if (inProgress.length > 1) {
      fail(`Multiple features are in_progress (${inProgress.map(f => f.id).join(', ')}) — path authorization is ambiguous; refusing the edit (F-0025 fail-closed). Resolve to a single in_progress feature.`);
    }
  }

  if (!activeFeature) {
    // Zero in_progress and no env override → permissive (no active feature is legitimate)
    process.exit(0);
  }

  const feature = (featuresData.features || []).find(f => f.id === activeFeature);
  if (!feature) {
    // Unknown feature: path-guard.js keeps existing fail-open behavior for unknown ids
    process.exit(0);
  }

  const authorized = feature.authorized_paths || [];
  const forbidden = feature.forbidden_paths || [];

  // 1. Check forbidden paths first
  for (const glob of forbidden) {
    if (matchGlob(normFile, glob)) {
      fail(`File "${filePath}" is in the forbidden_paths list of active feature "${activeFeature}" ("${glob}").`);
    }
  }

  // 2. Check authorized paths
  if (authorized.length > 0) {
    let isAuthorized = false;
    for (const glob of authorized) {
      if (matchGlob(normFile, glob)) {
        isAuthorized = true;
        break;
      }
    }
    if (!isAuthorized) {
      fail(`File "${filePath}" is not in the authorized_paths list of active feature "${activeFeature}".`);
    }
  }

  process.exit(0);
}

run();
