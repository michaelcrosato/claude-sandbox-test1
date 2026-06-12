#!/usr/bin/env bash
# PreToolUse[Bash] guard: blocks forbidden commands (AI_OPERATIONS_PLAN §6.2/§6.3).
# Exit 2 = block (stderr is shown to the agent). Exit 0 = allow.
set -u

INPUT="$(cat)"

# Emergency kill switch: a repo-root AGENT_STOP file halts all shell activity.
if [ -f "${CLAUDE_PROJECT_DIR:-.}/AGENT_STOP" ]; then
  echo "BLOCKED: AGENT_STOP file present. The operator has halted all work. Commit nothing further; end the session cleanly." >&2
  exit 2
fi

# Extract the command precisely (jq, else node). Matching the raw JSON would
# false-positive on commands whose arguments merely mention a pattern.
if command -v jq >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | jq -r '.tool_input.command // empty' 2>/dev/null)"
elif command -v node >/dev/null 2>&1; then
  CMD="$(printf '%s' "$INPUT" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d).tool_input?.command??"")}catch{}})' 2>/dev/null)"
else
  CMD="$INPUT"
fi
[ -z "$CMD" ] && exit 0

block() { echo "BLOCKED by guard-bash.sh: $1" >&2; exit 2; }

# Push to stable branches / force push.
# GITPUSH tolerates flags between git and push (git -C . push, git -c k=v push)
# and the target patterns cover refspec forms (HEAD:main, x:refs/heads/main).
GITPUSH='git[[:space:]]+((-C[[:space:]]+[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--(git-dir|work-tree|namespace|exec-path)(=[^[:space:]]+|[[:space:]]+[^[:space:]]+)|--?[A-Za-z][^[:space:]]*)[[:space:]]+)*push'
# Stable-branch targets: " main", ":main", "+main" (force-refspec), refs/heads/ forms
echo "$CMD" | grep -qE "${GITPUSH}[^|;&]*[ :+](refs/heads/)?(main|master)([^a-zA-Z0-9_-]|\$)" \
  && block "pushing to a stable branch (main/master) is prohibited; PRs target develop (CLAUDE.md §5)."
# Force pushes: --force/--force-with-lease/-f flags AND the +<refspec> syntax
echo "$CMD" | grep -qE "${GITPUSH}[^|;&]*(--force(-with-lease)?|[[:space:]]-f([[:space:]]|\$)|[[:space:]]\+[^[:space:]])" \
  && block "force-pushing is prohibited (including +refspec syntax); rebase locally or merge cleanly (CLAUDE.md §6)."

# Destructive filesystem operations outside temp
# shellcheck disable=SC2016  # pattern matches a literal dollar (HOME) — no expansion intended
echo "$CMD" | grep -qE 'rm[[:space:]]+-[a-zA-Z]*[rR][a-zA-Z]*[fF]?[a-zA-Z]*[[:space:]]+("?/([a-zA-Z]|$)|~|\$HOME)' \
  && block "recursive deletion of home/root paths is prohibited."

# Secrets
echo "$CMD" | grep -qE '(cat|less|more|head|tail|grep|awk|sed|type|strings)[[:space:]][^|;&]*\.env' \
  && block "reading .env files is prohibited (secrets boundary, CLAUDE.md §6)."

# Pipe-to-shell
echo "$CMD" | grep -qE '(curl|wget)[^|;&]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh' \
  && block "piping downloads to a shell is prohibited; download, inspect, then run."

# Package publishing
echo "$CMD" | grep -qE '(npm|pnpm|yarn)[[:space:]]+publish' \
  && block "package publishing is prohibited."

# Self-bypass of the assertion shield
echo "$CMD" | grep -q 'ASSERTION_SHIELD_BYPASS' \
  && block "setting ASSERTION_SHIELD_BYPASS is prohibited for agents; restore the assertions instead."

# Exfil-shaped uploads (F-0009, mirrors Anthropic's post-incident gh-wrapper fix):
# block ONLY when an upload-capable invocation carries secret-shaped content or
# a secret env var — plain gh api reads/writes of normal data stay allowed.
if echo "$CMD" | grep -qE '(curl|wget|gh[[:space:]]+api)[^|;&]*([[:space:]]-(d|F|T)[[:space:]]|--data|--form|--upload-file|--post-data|--post-file|--body-data|--body-file|-X[[:space:]]*(POST|PUT)|--method[[:space:]]*(POST|PUT)|-f[[:space:]]+[A-Za-z_]+=)'; then
  # shellcheck disable=SC2016  # patterns match literal $VAR references; no expansion intended
  echo "$CMD" | grep -qE '(sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}|BEGIN[[:space:]]+(RSA|EC|OPENSSH)?[[:space:]]*PRIVATE[[:space:]]+KEY|\$\{?(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)\}?)' \
    && block "exfil-shaped upload: secret-shaped content in a POST/upload command is prohibited (plan §7.2)."
fi

exit 0
