#!/usr/bin/env bash
# PreToolUse[Edit|Write] path-guard: enforces feature authorized_paths / forbidden_paths
# Exit 2 = block (stderr is shown to the agent). Exit 0 = allow.
set -u

# Run the Node script, passing stdin through
node "$(dirname "$0")/path-guard.js"
