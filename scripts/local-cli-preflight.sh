#!/usr/bin/env bash
# local-cli-preflight.sh -- catch Windows local CLI shell setups that break
# Claude Code hooks before they can spam hook errors or corrupt the prompt.
set -u

# WSL-bash-on-Windows: the misconfiguration this preflight exists to catch.
fail_wsl() {
  echo "LOCAL CLI PREFLIGHT FAILED: $1" >&2
  echo "" >&2
  echo "On Windows, run local Claude/agent CLI sessions from Git Bash, or prepend" >&2
  echo "Git Bash in PowerShell before launching the CLI:" >&2
  printf '%s\n' "  \$env:Path = 'C:\\Program Files\\Git\\bin;' + \$env:Path" >&2
  echo "  claude" >&2
  echo "" >&2
  echo "Why: this template's hooks and the security-guidance plugin invoke bash" >&2
  echo "with Windows paths. WSL bash cannot resolve those paths, which shows up as" >&2
  echo "repeated 'PostToolUse hook (failed)' messages and can leave terminal focus" >&2
  echo "events visible in the prompt as [I/[O text." >&2
  exit 1
}

# Missing toolchain: platform-neutral -- this path also fires on Linux/macOS,
# and on Windows it means Node/Git is absent, not that the wrong shell is in use.
fail_missing() {
  echo "LOCAL CLI PREFLIGHT FAILED: $1" >&2
  echo "" >&2
  echo "Install it and make sure it is on this shell's PATH, then re-run." >&2
  echo "On Windows, launch from Git Bash so Node and Git resolve the same way the" >&2
  echo "hooks do." >&2
  exit 1
}

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

is_ci() {
  [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ]
}

UNAME_S="$(uname -s 2>/dev/null || echo unknown)"
UNAME_R="$(uname -r 2>/dev/null || echo unknown)"

case "$UNAME_S" in
  MINGW*|MSYS*|CYGWIN*)
    ;;
  Linux*)
    case "$UNAME_R:${WSL_INTEROP:-}:${WSL_DISTRO_NAME:-}" in
      *[Mm]icrosoft*|*WSL*|*wsl*)
        if ! is_ci && ! has_cmd cygpath; then
          fail_wsl "this session is using WSL bash on Windows, not Git Bash."
        fi
        ;;
    esac
    ;;
  *)
    ;;
esac

for required in node git; do
  if ! has_cmd "$required"; then
    fail_missing "'$required' is not available inside this bash PATH."
  fi
done

exit 0
