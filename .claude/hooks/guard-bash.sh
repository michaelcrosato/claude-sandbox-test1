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

# Secrets — bash/Unix forms
echo "$CMD" | grep -qE '(cat|less|more|head|tail|grep|awk|sed|type|strings)[[:space:]][^|;&]*\.env' \
  && block "reading .env files is prohibited (secrets boundary, CLAUDE.md §6)."

# Secrets — PowerShell Get-Content / gc / Get-ChildItem on .env* files.
# Matches ".env", ".env.local", ".env.production", etc. as a whole filename token
# (requires .env followed by end-of-token or non-alpha). Does NOT match ".environment".
# shellcheck disable=SC2016  # -i used deliberately; no variable expansion intended here
echo "$CMD" | grep -qiE '(Get-Content|gc|Get-ChildItem|gci)[[:space:]][^|;&]*\.env([^A-Za-z]|$)' \
  && block "reading .env files via PowerShell Get-Content/gc/Get-ChildItem is prohibited (secrets boundary, CLAUDE.md §6)."

# Secrets — .NET [System.IO.File] static read methods on .env* files
echo "$CMD" | grep -qiE '\[System\.IO\.File\]::ReadAll(Text|Lines|Bytes)[^|;&]*\.env([^A-Za-z]|$)' \
  && block "reading .env files via [System.IO.File]::ReadAll* is prohibited (secrets boundary, CLAUDE.md §6)."

# Secrets — Unix binary/dump utilities on .env* files (xxd, od, dd if=, base64, nl, cut)
echo "$CMD" | grep -qE '(xxd|od|base64|nl|cut)[[:space:]][^|;&]*\.env([^A-Za-z]|$)' \
  && block "reading .env files via binary/dump utilities is prohibited (secrets boundary, CLAUDE.md §6)."
echo "$CMD" | grep -qE 'dd[[:space:]]+if=\.env([^A-Za-z]|$)' \
  && block "reading .env files via dd is prohibited (secrets boundary, CLAUDE.md §6)."

# Secrets — shell input-redirection of .env* files  (< .env  or  < .env.local  etc.)
echo "$CMD" | grep -qE '<[[:space:]]*\.env([^A-Za-z]|$)' \
  && block "input-redirecting .env files is prohibited (secrets boundary, CLAUDE.md §6)."

# Pipe-to-shell
echo "$CMD" | grep -qE '(curl|wget)[^|;&]*\|[[:space:]]*(sudo[[:space:]]+)?(ba|z|da)?sh' \
  && block "piping downloads to a shell is prohibited; download, inspect, then run."

# Package publishing
echo "$CMD" | grep -qE '(npm|pnpm|yarn)[[:space:]]+publish' \
  && block "package publishing is prohibited."

# Self-bypass of the assertion shield — bash form
echo "$CMD" | grep -q 'ASSERTION_SHIELD_BYPASS' \
  && block "setting ASSERTION_SHIELD_BYPASS is prohibited for agents; restore the assertions instead."

# Destructive PowerShell Remove-Item with -Recurse/-r targeting root or home paths.
# Only blocks when BOTH a recursive flag AND a sensitive root target are present.
# Sensitive targets: bare / (Unix root), /letter (absolute Unix), C:\ (Windows root),
# ~ (home shorthand), $HOME, $env:USERPROFILE, $env:HOME.
# Benign Remove-Item (e.g. "Remove-Item tmp/foo" or "Remove-Item -Recurse node_modules") is NOT matched.
# shellcheck disable=SC2016  # patterns match literal $HOME/$env: tokens; no expansion intended
echo "$CMD" | grep -qiE 'Remove-Item[^|;&]*(-Recurse|-r[[:space:]])[^|;&]*[[:space:]]"?(/([a-zA-Z]|$)|C:\\|~|\$HOME|\$env:(USERPROFILE|HOME))' \
  && block "recursive PowerShell Remove-Item on root/home paths is prohibited."
# shellcheck disable=SC2016  # patterns match literal $HOME/$env: tokens; no expansion intended
echo "$CMD" | grep -qiE 'Remove-Item[^|;&]*[[:space:]]"?(/([a-zA-Z]|$)|C:\\|~|\$HOME|\$env:(USERPROFILE|HOME))[^|;&]*(-Recurse|-r[[:space:]])' \
  && block "recursive PowerShell Remove-Item on root/home paths is prohibited."

# Exfil — PowerShell Invoke-RestMethod / Invoke-WebRequest with upload indicators
# Blocks -Method Post/-Body/-InFile combos. Plain GET calls are not matched.
echo "$CMD" | grep -qiE '(Invoke-RestMethod|irm|Invoke-WebRequest|iwr|curl\.exe|wget\.exe)[^|;&]*(-Method[[:space:]]+(Post|Put)|-Body[[:space:]]|-InFile[[:space:]])' \
  && block "PowerShell exfil-shaped upload (Invoke-RestMethod/Invoke-WebRequest -Method Post/-Body/-InFile) is prohibited."

# Exfil-shaped uploads (F-0009, mirrors Anthropic's post-incident gh-wrapper fix):
# block ONLY when an upload-capable invocation carries secret-shaped content or
# a secret env var — plain gh api reads/writes of normal data stay allowed.
if echo "$CMD" | grep -qE '(curl|wget|gh[[:space:]]+api)[^|;&]*([[:space:]]-(d|F|T)[[:space:]]|--data|--form|--upload-file|--post-data|--post-file|--body-data|--body-file|-X[[:space:]]*(POST|PUT)|--method[[:space:]]*(POST|PUT)|-f[[:space:]]+[A-Za-z_]+=)'; then
  # shellcheck disable=SC2016  # patterns match literal $VAR references; no expansion intended
  echo "$CMD" | grep -qE '(sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,}|\b(ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}|BEGIN[[:space:]]+(RSA|EC|OPENSSH)?[[:space:]]*PRIVATE[[:space:]]+KEY|\$\{?(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|GITHUB_TOKEN|GH_TOKEN)\}?)' \
    && block "exfil-shaped upload: secret-shaped content in a POST/upload command is prohibited (plan §7.2)."
fi

# Bypass env var — PowerShell $env: assignment form
# shellcheck disable=SC2016  # matches literal $env: syntax; no expansion intended
echo "$CMD" | grep -q '$env:ASSERTION_SHIELD_BYPASS' \
  && block "setting ASSERTION_SHIELD_BYPASS via PowerShell \$env: is prohibited for agents; restore the assertions instead."

exit 0
