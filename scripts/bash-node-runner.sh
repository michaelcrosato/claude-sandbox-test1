#!/usr/bin/env bash
# Internal runner used by bash-node-bridge.sh when Bash can only see node.exe.
set -u

NODE_EXE="${BASH_NODE_EXE:-}"
if [ -z "$NODE_EXE" ]; then
  NODE_EXE="$(command -v node.exe 2>/dev/null || true)"
fi
[ -n "$NODE_EXE" ] || { echo "node.exe not found" >&2; exit 127; }

add_wslenv() {
  local entry="$1"
  local name="${entry%%/*}"
  case ":${WSLENV:-}:" in
    *":$name:"*|*":$name/"*) ;;
    *) WSLENV="${WSLENV:+$WSLENV:}$entry" ;;
  esac
}

for name in STATE_FILE/p MODEL_POLICY_FILE/p METRICS_FILE/p BASE_BRANCH ASSERTION_SHIELD_BYPASS CI DATABASE_URL SEED_SHIM_ACTIVE; do
  add_wslenv "$name"
done
export WSLENV

ARGS=()
SKIP_NEXT=false
for arg in "$@"; do
  if [ "$SKIP_NEXT" = true ]; then
    ARGS+=("$arg")
    SKIP_NEXT=false
    continue
  fi

  case "$arg" in
    -e|--eval|-p|--print)
      ARGS+=("$arg")
      SKIP_NEXT=true
      continue
      ;;
  esac

  if [ "${arg#/}" != "$arg" ] && command -v wslpath >/dev/null 2>&1; then
    if converted="$(wslpath -w "$arg" 2>/dev/null)"; then
      ARGS+=("$converted")
    else
      ARGS+=("$arg")
    fi
  else
    ARGS+=("$arg")
  fi
done

exec "$NODE_EXE" "${ARGS[@]}"
