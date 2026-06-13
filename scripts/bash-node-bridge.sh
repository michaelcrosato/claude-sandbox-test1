#!/usr/bin/env bash
# Source this from Bash-based gates before they call bare `node`.
# Windows Node installs expose node.exe to WSL/Git Bash, while repo scripts use
# the cross-platform `node` command name.
if ! command -v node >/dev/null 2>&1 && command -v node.exe >/dev/null 2>&1; then
  BRIDGE_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  BRIDGE_RUNNER="$BRIDGE_SCRIPT_DIR/bash-node-runner.sh"
  CURRENT_RUNNER=""
  if [ -n "${BASH_NODE_BRIDGE_DIR:-}" ] && [ -L "$BASH_NODE_BRIDGE_DIR/node" ]; then
    CURRENT_RUNNER="$(readlink "$BASH_NODE_BRIDGE_DIR/node" 2>/dev/null || true)"
  fi
  if [ "$CURRENT_RUNNER" != "$BRIDGE_RUNNER" ]; then
    BASH_NODE_BRIDGE_DIR="$(mktemp -d)"
    ln -s "$BRIDGE_RUNNER" "$BASH_NODE_BRIDGE_DIR/node"
    export BASH_NODE_BRIDGE_DIR
  fi
  BASH_NODE_EXE="$(command -v node.exe)"
  export BASH_NODE_EXE
  PATH="$BASH_NODE_BRIDGE_DIR:$PATH"
  export PATH
fi
