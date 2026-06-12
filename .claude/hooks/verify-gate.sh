#!/usr/bin/env bash
# PreToolUse[Edit|Write] gate: roadmap/features.json is never hand-edited.
# All mutations go through scripts/update-state.ts, which enforces the
# default-FAIL evidence contract (AI_OPERATIONS_PLAN §4.2, §6.3).
set -u

INPUT="$(cat)"

# Parse file_path precisely (jq, else node, else sed). Matching the raw JSON
# would false-positive on any file whose CONTENT mentions features.json.
# VERIFY_GATE_PARSER=sed|node|jq forces a branch — test seam for contract tests
# (still fail-closed: every branch extracts then blocks on match).
PARSER="${VERIFY_GATE_PARSER:-auto}"
if { [ "$PARSER" = "auto" ] || [ "$PARSER" = "jq" ]; } && command -v jq >/dev/null 2>&1; then
  FILE="$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
elif { [ "$PARSER" = "auto" ] || [ "$PARSER" = "node" ]; } && command -v node >/dev/null 2>&1; then
  FILE="$(printf '%s' "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).tool_input?.file_path??"")}catch{}})' 2>/dev/null)"
else
  # Last resort (no jq, no node): take the FIRST "file_path" value in the JSON.
  # tool_input.file_path serializes before content, so first match is the real
  # field — a decoy "file_path" embedded in content can't shadow it. A gate that
  # fails open is worse than a crude parser (found via contract tests).
  FILE="$(printf '%s' "$INPUT" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*"\(.*\)"$/\1/')"
fi

# Normalize before matching (security review: roadmap/./features.json and
# roadmap//features.json resolve to the gated file but dodge substring globs).
FILE="${FILE//\\//}"                       # backslashes → slashes
while case "$FILE" in *//*|*/./*) true ;; *) false ;; esac; do
  FILE="${FILE//\/\///}"                   # // → /
  FILE="${FILE//\/.\///}"                  # /./ → /
done
BASE="${FILE##*/}"

# Block any path whose basename is features.json inside a roadmap/ segment
# (covers ../ re-entry tricks; over-blocking is fail-safe here).
if [ "$BASE" = "features.json" ]; then
  case "/$FILE/" in
    */roadmap/*)
      echo "BLOCKED: direct edits to roadmap/features.json are prohibited. Use: npx ts-node scripts/update-state.ts (--add | --status | --evidence | --attempt | --passes). It validates the schema and the evidence contract; hand edits corrupt the backlog." >&2
      exit 2
      ;;
  esac
fi

exit 0
