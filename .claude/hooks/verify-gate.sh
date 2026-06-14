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

# F-0007 / F-0022: PreToolUse per-feature authz guard.
# Active feature precedence (F-0022 mechanical derivation):
#   1. CLAUDE_ACTIVE_FEATURE env var (explicit override — keeps existing flows working)
#   2. Exactly ONE feature with status=="in_progress" in state file (derived automatically)
#   3. Zero or multiple in_progress → no active feature; fall through (allow)
# Fail-closed on any ambiguity/missing/no-authorized/unknown-feature/parse-err.
# Supports ** (as "dir/**" prefix incl segment match for abs paths), exact files, simple *.
# Only acts on Edit/Write; reads and other tools unaffected.

# Determine active feature: env var first, then mechanical derivation.
# F-0025: 2+ in_progress is anomalous (the single-in_progress invariant blocks it at the
# writer); if it occurs anyway the gate FAILS CLOSED rather than going permissive.
ACTIVE_FEATURE="${CLAUDE_ACTIVE_FEATURE:-}"
if [ -z "$ACTIVE_FEATURE" ]; then
  STATE="${STATE_FILE:-${CLAUDE_PROJECT_DIR:-.}/roadmap/features.json}"
  if [ -f "$STATE" ]; then
    DERIVED=""
    if command -v node >/dev/null 2>&1; then
      DERIVED="$(cat "$STATE" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{ try{
  const j=JSON.parse(d||"{}");
  const ip=(j.features||[]).filter(x=>x&&x.status==="in_progress");
  if(ip.length===1){console.log(ip[0].id);} else if(ip.length>1){console.log("__MULTIPLE__");}
}catch{}
})' 2>/dev/null || true)"
    elif command -v jq >/dev/null 2>&1; then
      DERIVED="$(jq -r '[.features//[]|.[]|select(.status=="in_progress")]|if length==1 then .[0].id elif length>1 then "__MULTIPLE__" else "" end' "$STATE" 2>/dev/null || true)"
    fi
    if [ "$DERIVED" = "__MULTIPLE__" ]; then
      echo "BLOCKED: multiple features in_progress — path authorization is ambiguous; refusing the edit (F-0025 fail-closed). Resolve to a single in_progress feature." >&2
      exit 2
    fi
    ACTIVE_FEATURE="${DERIVED:-}"
  fi
fi

if [ -n "$ACTIVE_FEATURE" ]; then
  export ACTIVE_FEATURE
  STATE="${STATE_FILE:-${CLAUDE_PROJECT_DIR:-.}/roadmap/features.json}"
  if [ ! -f "$STATE" ]; then
    echo "BLOCKED: active feature=$ACTIVE_FEATURE but state file missing at $STATE (fail-closed)." >&2
    exit 2
  fi

  AUTHZ="[]"
  FORB="[]"
  if command -v node >/dev/null 2>&1; then
    AUTHZ="$(cat "$STATE" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{ try{
  const j=JSON.parse(d||"{}"); const id=process.env.ACTIVE_FEATURE||"";
  const f=(j.features||[]).find(x=>x&&x.id===id);
  if(!f){console.log("NOTFOUND");return;}
  console.log(JSON.stringify(f.authorized_paths||[]));
}catch{console.log("PARSEERR");}
})' 2>/dev/null || echo "PARSEERR")"
    FORB="$(cat "$STATE" | node -e '
let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{ try{
  const j=JSON.parse(d||"{}"); const id=process.env.ACTIVE_FEATURE||"";
  const f=(j.features||[]).find(x=>x&&x.id===id);
  if(!f){console.log("NOTFOUND");return;}
  console.log(JSON.stringify(f.forbidden_paths||[]));
}catch{console.log("PARSEERR");}
})' 2>/dev/null || echo "PARSEERR")"
    if [ "$AUTHZ" = "NOTFOUND" ] || [ "$FORB" = "NOTFOUND" ]; then
      echo "BLOCKED: active feature=$ACTIVE_FEATURE not found in state (fail-closed)." >&2
      exit 2
    fi
    if [ "$AUTHZ" = "PARSEERR" ] || [ "$FORB" = "PARSEERR" ]; then
      echo "BLOCKED: failed to parse state for $ACTIVE_FEATURE authz/forbidden (fail-closed)." >&2
      exit 2
    fi
  elif command -v jq >/dev/null 2>&1; then
    AUTHZ="$(jq -c -r --arg id "$ACTIVE_FEATURE" '(.features//[])|map(select(.id==$id))|if length>0 then (.[0].authorized_paths//[])|@json else "NOTFOUND" end' "$STATE" 2>/dev/null || echo "NOTFOUND")"
    FORB="$(jq -c -r --arg id "$ACTIVE_FEATURE" '(.features//[])|map(select(.id==$id))|if length>0 then (.[0].forbidden_paths//[])|@json else "NOTFOUND" end' "$STATE" 2>/dev/null || echo "NOTFOUND")"
    if [ "$AUTHZ" = "NOTFOUND" ] || [ "$FORB" = "NOTFOUND" ]; then
      echo "BLOCKED: active feature=$ACTIVE_FEATURE not found or jq failed (fail-closed)." >&2
      exit 2
    fi
  else
    echo "BLOCKED: active feature=$ACTIVE_FEATURE but no node/jq available to enforce per-feature authz (fail-closed)." >&2
    exit 2
  fi

  # matches_any <json-array> <file> — echoes 0 (match) or 1 (no). node primary; bash fallback for jq-only envs.
  matches_any() {
    local arr="$1" fp="$2"
    if command -v node >/dev/null 2>&1; then
      node -e '
let pats=[];try{pats=JSON.parse(process.argv[1]||"[]")}catch{process.exit(2)}
let fp=(process.argv[2]||"").replace(/\\/g,"/").replace(/\/+/g,"/").replace(/^[A-Za-z]:/,"").replace(/^\/+/,"").replace(/^\.\//,"");
for(let p0 of pats){
  let p=p0.replace(/\\/g,"/").replace(/\/+/g,"/").replace(/^[A-Za-z]:/,"").replace(/^\/+/,"").replace(/^\.\//,"");
  if(p===fp||fp===p||fp.endsWith("/"+p)||p.endsWith("/"+fp)){process.exit(0);}
  if(p==="**"){process.exit(0);}
  if(p.endsWith("/**")){
    let pre=p.slice(0,-3);if(pre.endsWith("/"))pre=pre.slice(0,-1);
    if(!pre||fp===pre||fp.startsWith(pre+"/")){process.exit(0);}
    if(("/"+fp+"/").indexOf("/"+pre+"/")>=0){process.exit(0);}
    if(fp.endsWith("/"+pre)){process.exit(0);}
  }
}
process.exit(1);
' "$arr" "$fp" 2>/dev/null ; echo $?
    else
      # degraded (jq no node): bash covers **-prefix + exact + suffix (patterns actually used)
      local clean="${arr#[}"; clean="${clean%]}"; clean="${clean//\"/}"; clean="${clean// /}"
      local IFS=, p f="$fp"
      for p in $clean; do
        [ -z "$p" ] && continue
        [ "$p" = "$f" ] && { echo 0; return; }
        [ "$f" = "$p" ] && { echo 0; return; }
        case "$f" in "$p") echo 0; return ;; esac
        case "$f" in *"/$p") echo 0; return ;; esac
        if [ "${p#*\*\*}" != "$p" ]; then
          pre="${p%\*\*}"; pre="${pre%/}"
          case "$f" in "$pre"*|"$pre/"*) echo 0; return ;; esac
          case "/$f/" in *"/$pre/"*) echo 0; return ;; esac
          case "$f" in *"/$pre") echo 0; return ;; esac
        fi
      done
      echo 1; return
    fi
  }

  # forbidden wins (block even if would be in authz)
  if [ "$FORB" != "[]" ]; then
    if [ "$(matches_any "$FORB" "$FILE")" -eq 0 ]; then
      echo "BLOCKED: $FILE matches a forbidden_paths entry for active feature $ACTIVE_FEATURE." >&2
      exit 2
    fi
  fi

  # must be covered by at least one authorized_paths glob
  if [ "$AUTHZ" = "[]" ]; then
    echo "BLOCKED: active feature $ACTIVE_FEATURE has empty authorized_paths (fail-closed)." >&2
    exit 2
  fi
  if [ "$(matches_any "$AUTHZ" "$FILE")" -ne 0 ]; then
    echo "BLOCKED: $FILE is outside authorized_paths for active feature $ACTIVE_FEATURE." >&2
    exit 2
  fi
  # here: allowed
fi

exit 0
