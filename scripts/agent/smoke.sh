#!/usr/bin/env bash
# Build dist, then run every compiled-dist smoke (scripts/smoke-*.mjs) except the
# Postgres one. smoke-postgres.mjs needs a live PG service, so run it separately
# with POSTHORN_TEST_PG_URL set. Fails on the first smoke that exits non-zero.
#
# smoke-python-sdk.mjs spawns Python; set $PYTHON to choose the interpreter (it
# defaults to "python"). Smokes bind 127.0.0.1 on ephemeral ports and run serially.
source "$(dirname -- "$0")/_common.sh"
shopt -s nullglob

run_script build

ran=0
for f in scripts/smoke-*.mjs; do
  if [ "$f" = "scripts/smoke-postgres.mjs" ]; then
    skip "$f (needs a Postgres service; run separately with POSTHORN_TEST_PG_URL)"
    continue
  fi
  info "smoke: $f"
  if node "$f"; then
    ok "$f"
    ran=$((ran + 1))
  else
    fail "$f exited non-zero"
    exit 1
  fi
done

ok "all $ran compiled-dist smokes passed"
