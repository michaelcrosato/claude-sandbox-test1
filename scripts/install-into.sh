#!/usr/bin/env bash
# install-into.sh -- drop-in installer for the AI operations engine.
# Usage: bash scripts/install-into.sh <target-dir>
# Run from the template repo root (or any location; script resolves its own root).
# Portability: git-bash on Windows + ubuntu CI. No GNU-only flags.
set -eu

TEMPLATE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-}"

# -- Refusals ------------------------------------------------------------------

if [ -z "$TARGET" ]; then
  echo "ERROR: no target directory supplied." >&2
  echo "Usage: bash scripts/install-into.sh <target-dir>" >&2
  exit 1
fi

if [ ! -d "$TARGET" ]; then
  echo "ERROR: '$TARGET' does not exist or is not a directory." >&2
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"

# Refuse if target IS the template root
if [ "$TARGET" = "$TEMPLATE_ROOT" ]; then
  echo "ERROR: target is the template repo itself ($TEMPLATE_ROOT). Run against your adopter repo." >&2
  exit 1
fi

# Refuse if target is an ancestor of the template root (cp -r into ancestor risks recursive self-copy)
case "$TEMPLATE_ROOT" in
  "$TARGET"/*)
    echo "ERROR: target '$TARGET' is an ancestor of the template root. This would risk a recursive self-copy." >&2
    exit 1
    ;;
esac

echo "=== install-into.sh: Installing AI operations engine ==="
echo "  Template root : $TEMPLATE_ROOT"
echo "  Target        : $TARGET"
echo ""

# -- Engine-owned files (overwrite on every run -- this is the upgrade path) ---

echo "--- Copying engine-owned files (overwrite) ---"

# Root docs
for f in CLAUDE.md AGENTS.md AI_OPERATIONS_PLAN.md OPERATOR_GUIDE.md; do
  if [ -f "$TEMPLATE_ROOT/$f" ]; then
    if [ -f "$TARGET/$f" ]; then
      cp "$TEMPLATE_ROOT/$f" "$TARGET/$f"
      echo "  overwrote existing: $f"
    else
      cp "$TEMPLATE_ROOT/$f" "$TARGET/$f"
      echo "  copied: $f"
    fi
  fi
done

# Directory trees: .claude/, scripts/, .github/
# Merge-copy: mkdir -p preserves adopter files; cp -r with /. copies contents into the
# existing dir, overwriting same-named engine files while keeping adopter-added files.
# Trade-off: stale engine files from older template versions may linger — accepted cost
# of the hard rule "never delete anything" (data loss > leftover files).
for d in .claude scripts .github; do
  if [ -d "$TEMPLATE_ROOT/$d" ]; then
    mkdir -p "$TARGET/$d"
    cp -r "$TEMPLATE_ROOT/$d/." "$TARGET/$d/"
    echo "  merged tree: $d/"
  fi
done

# docs/optional-modules.md (but NOT docs/feedback-2-*)
if [ -f "$TEMPLATE_ROOT/docs/optional-modules.md" ]; then
  mkdir -p "$TARGET/docs"
  cp "$TEMPLATE_ROOT/docs/optional-modules.md" "$TARGET/docs/optional-modules.md"
  echo "  copied: docs/optional-modules.md"
fi

# roadmap structural files
mkdir -p "$TARGET/roadmap/briefs"
if [ -f "$TEMPLATE_ROOT/roadmap/features.schema.json" ]; then
  cp "$TEMPLATE_ROOT/roadmap/features.schema.json" "$TARGET/roadmap/features.schema.json"
  echo "  copied: roadmap/features.schema.json"
fi
if [ -f "$TEMPLATE_ROOT/roadmap/briefs/TEMPLATE.md" ]; then
  cp "$TEMPLATE_ROOT/roadmap/briefs/TEMPLATE.md" "$TARGET/roadmap/briefs/TEMPLATE.md"
  echo "  copied: roadmap/briefs/TEMPLATE.md"
fi

echo ""

# -- Copy-if-absent, warn-if-present -------------------------------------------

echo "--- Conditionally copying config files ---"

for f in biome.json tsconfig.json .gitattributes; do
  if [ -f "$TARGET/$f" ]; then
    echo "  WARNING: '$f' already exists in target -- manual merge may be needed (especially .gitattributes LF pinning, which is load-bearing for bash hooks)."
  else
    if [ -f "$TEMPLATE_ROOT/$f" ]; then
      cp "$TEMPLATE_ROOT/$f" "$TARGET/$f"
      echo "  copied (was absent): $f"
    fi
  fi
done

echo ""

# -- .gitignore: copy if absent, append missing load-bearing lines if present --

echo "--- Ensuring .gitignore has load-bearing entries ---"

if [ ! -f "$TARGET/.gitignore" ]; then
  if [ -f "$TEMPLATE_ROOT/.gitignore" ]; then
    cp "$TEMPLATE_ROOT/.gitignore" "$TARGET/.gitignore"
    echo "  copied: .gitignore"
  else
    printf 'node_modules/\ntmp/\n*.log\n!roadmap/evidence/**\n.claude/settings.local.json\n' > "$TARGET/.gitignore"
    echo "  created: .gitignore (from required lines)"
  fi
else
  echo "  .gitignore exists -- checking for missing load-bearing lines..."
  for required_line in 'node_modules/' 'tmp/' '*.log' '!roadmap/evidence/**' '.claude/settings.local.json'; do
    if ! grep -qxF "$required_line" "$TARGET/.gitignore"; then
      printf '\n%s\n' "$required_line" >> "$TARGET/.gitignore"
      echo "    appended missing line: $required_line"
    fi
  done
fi

echo ""

# -- Fresh roadmap state (seed only if file is absent) -------------------------

echo "--- Seeding fresh roadmap state (skip if file already exists) ---"

# features.json -- seed empty backlog
if [ ! -f "$TARGET/roadmap/features.json" ]; then
  cat > "$TARGET/roadmap/features.json" << 'SEEDJSON'
{
  "$schema": "./features.schema.json",
  "features": []
}
SEEDJSON
  echo "  seeded: roadmap/features.json (empty backlog)"
else
  echo "  kept existing: roadmap/features.json"
fi

# PROGRESS.md
if [ ! -f "$TARGET/roadmap/PROGRESS.md" ]; then
  if [ -f "$TEMPLATE_ROOT/roadmap/PROGRESS.md" ]; then
    head -4 "$TEMPLATE_ROOT/roadmap/PROGRESS.md" > "$TARGET/roadmap/PROGRESS.md"
  else
    printf '# Progress Log\n\n> Newest entry first. Each session prepends a block.\n' > "$TARGET/roadmap/PROGRESS.md"
  fi
  echo "  seeded: roadmap/PROGRESS.md"
else
  echo "  kept existing: roadmap/PROGRESS.md"
fi

# DECISIONS.md
if [ ! -f "$TARGET/roadmap/DECISIONS.md" ]; then
  if [ -f "$TEMPLATE_ROOT/roadmap/DECISIONS.md" ]; then
    head -4 "$TEMPLATE_ROOT/roadmap/DECISIONS.md" > "$TARGET/roadmap/DECISIONS.md"
  else
    printf '# Decisions Log (append-only, ADR-lite)\n\n> One entry per autonomous judgment call.\n' > "$TARGET/roadmap/DECISIONS.md"
  fi
  echo "  seeded: roadmap/DECISIONS.md"
else
  echo "  kept existing: roadmap/DECISIONS.md"
fi

# QUESTIONS.md
if [ ! -f "$TARGET/roadmap/QUESTIONS.md" ]; then
  if [ -f "$TEMPLATE_ROOT/roadmap/QUESTIONS.md" ]; then
    head -4 "$TEMPLATE_ROOT/roadmap/QUESTIONS.md" > "$TARGET/roadmap/QUESTIONS.md"
  else
    printf '# Questions\n\n> Agent-written, human-answered, inline.\n' > "$TARGET/roadmap/QUESTIONS.md"
  fi
  echo "  seeded: roadmap/QUESTIONS.md"
else
  echo "  kept existing: roadmap/QUESTIONS.md"
fi

# ROADMAP.md — seed the template's preamble (everything before its first "## "
# section heading) then append the canonical empty skeleton. Using sed to take
# the preamble (not head -N) keeps the generic operator guidance without copying
# the template's own shipped-item bullets, and emits each heading exactly once:
# head -5 used to capture the template's own "## Now" and then append a second
# one, producing a duplicate "## Now" (reported by 3/9 fleet installs 2026-06-11).
if [ ! -f "$TARGET/roadmap/ROADMAP.md" ]; then
  if [ -f "$TEMPLATE_ROOT/roadmap/ROADMAP.md" ]; then
    sed '/^## /,$d' "$TEMPLATE_ROOT/roadmap/ROADMAP.md" > "$TARGET/roadmap/ROADMAP.md"
  else
    printf '# Roadmap\n\n' > "$TARGET/roadmap/ROADMAP.md"
  fi
  printf '## Now\n\n## Next\n\n## Later\n\n## Ideas\n' >> "$TARGET/roadmap/ROADMAP.md"
  echo "  seeded: roadmap/ROADMAP.md"
else
  echo "  kept existing: roadmap/ROADMAP.md"
fi

# STATUS.md
if [ ! -f "$TARGET/roadmap/STATUS.md" ]; then
  printf "# Status\n\nNot yet generated -- the orchestrator's \`/status\` skill writes this report.\n" > "$TARGET/roadmap/STATUS.md"
  echo "  seeded: roadmap/STATUS.md"
else
  echo "  kept existing: roadmap/STATUS.md"
fi

# metrics.jsonl -- empty file
if [ ! -f "$TARGET/roadmap/metrics.jsonl" ]; then
  touch "$TARGET/roadmap/metrics.jsonl"
  echo "  seeded: roadmap/metrics.jsonl (empty)"
else
  echo "  kept existing: roadmap/metrics.jsonl"
fi

# evidence/.gitkeep
mkdir -p "$TARGET/roadmap/evidence"
if [ ! -f "$TARGET/roadmap/evidence/.gitkeep" ]; then
  touch "$TARGET/roadmap/evidence/.gitkeep"
  echo "  seeded: roadmap/evidence/.gitkeep"
fi

echo ""

# -- package.json transform ----------------------------------------------------
# Write a temp JS file and invoke it with node, passing TARGET as an argument.
# This avoids shell path interpolation inside node -e strings (breaks on Windows
# git-bash where POSIX paths like /c/dev/... get mangled by node's native fs).

echo "--- Transforming package.json ---"

PKG_TRANSFORM_SCRIPT="$(mktemp /tmp/install-into-pkg-XXXXXX.js)"
# Remove the temp script even on early exit (security review, F-0013)
trap 'rm -f "$PKG_TRANSFORM_SCRIPT"' EXIT

cat > "$PKG_TRANSFORM_SCRIPT" << 'NODEEOF'
const fs = require('fs');
const path = require('path');
const target = process.argv[2];
const pkgPath = path.join(target, 'package.json');
const engineScripts = {
  "verify": "bash scripts/verify.sh",
  "shield": "ts-node scripts/assertion-shield.ts",
  "state": "ts-node scripts/update-state.ts",
  "state:validate": "ts-node scripts/update-state.ts --validate",
  "typecheck": "tsc --noEmit",
  "lint": "biome lint scripts"
};
const engineDeps = {
  "@biomejs/biome": "^2.4.16",
  "@types/node": "^25.9.2",
  "shellcheck": "^4.1.0",
  "ts-node": "^10.9.2",
  "typescript": "^6.0.3"
};

let pkg;
if (fs.existsSync(pkgPath)) {
  pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  if (pkg.name === 'ai-operations-template') {
    process.stderr.write('WARNING: package.json name is still ai-operations-template -- rename it to your project name (activates the placeholder check in verify.sh).\n');
  }
  if (!pkg.scripts) pkg.scripts = {};
  for (const [k, v] of Object.entries(engineScripts)) {
    if (!(k in pkg.scripts)) {
      pkg.scripts[k] = v;
    }
  }
  // NEVER add or modify test script
  if (!pkg.devDependencies) pkg.devDependencies = {};
  for (const [k, v] of Object.entries(engineDeps)) {
    if (!(k in pkg.devDependencies)) {
      pkg.devDependencies[k] = v;
    }
  }
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  process.stdout.write('  merged: package.json (kept existing name/scripts/devDependencies)\n');
} else {
  pkg = {
    name: 'adopter-project-rename-me',
    version: '0.0.0',
    private: true,
    scripts: engineScripts,
    devDependencies: engineDeps
  };
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  process.stdout.write('  created: package.json (placeholder name; rename before first session)\n');
}
NODEEOF

node "$PKG_TRANSFORM_SCRIPT" "$TARGET"
rm -f "$PKG_TRANSFORM_SCRIPT"

echo ""

# -- src/ warning --------------------------------------------------------------

if [ -d "$TARGET/src" ]; then
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "!! WARNING: target already contains src/                                   !!"
  echo "!! verify.sh will run in PRODUCT MODE there. This means:                  !!"
  echo "!!   - A missing 'test' script in package.json is a HARD FAILURE          !!"
  echo "!!   - A missing 'lint' script in package.json is a HARD FAILURE          !!"
  echo "!! The engine NEVER invents these gates -- you must define them yourself.  !!"
  echo "!! (This is designed behavior: your product test and lint gates are yours) !!"
  echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
fi

# -- LICENSE reminder ----------------------------------------------------------

echo "--- Reminder ---"
echo "  LICENSE was not copied -- keep or replace the MIT license per your project (manual step)."
echo ""

# -- Final manual steps --------------------------------------------------------

echo "================================================================"
echo "Install complete. Remaining manual steps:"
echo ""
echo "  1. Replace every <PLACEHOLDER> token in the docs:"
echo "       grep -rE \"<[A-Z][A-Z0-9_]{2,}>\" *.md"
echo "     (repo name, deployment surface, database service, E2E framework)"
echo ""
echo "  2. Set your project name in package.json:"
echo "       Change 'name' to your project's npm-valid name."
echo "     (This activates the automatic leftover-placeholder check in verify.sh)"
echo ""
echo "  3. Initialize and verify the engine:"
echo "       bash scripts/init.sh"
echo "       bash scripts/verify.sh"
echo "     Both must pass before the first agent session."
echo ""
echo "     Windows local CLI note: run those commands from Git Bash. If PowerShell"
echo "     resolves 'bash' to WSL, prepend Git Bash before launching Claude/CLI:"
printf '%s\n' "       \$env:Path = 'C:\\Program Files\\Git\\bin;' + \$env:Path"
echo ""
echo "  4. Set 'develop' as the GitHub default branch."
echo "     Protect master/main (PR + human approval) and develop (PR + green CI)."
echo "     Because develop blocks direct pushes, roadmap-state updates land via PRs:"
echo "     state flips ride the feature PR itself; post-merge records (progress/"
echo "     status/metrics) go via short-lived chore/ branches -- the record-PR pattern."
echo ""
echo "  5. Seed your backlog: start the orchestrator and run /groom against your"
echo "     product spec."
echo ""
echo "  6. Keep or replace LICENSE (MIT) per your project."
echo "================================================================"
