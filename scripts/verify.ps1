#!/usr/bin/env pwsh
# Windows canonical entry point for the gate.
#
# Why this exists: on Windows, `bash scripts/verify.sh` often resolves to
# C:\Windows\System32\bash.exe (WSL), where `node`/`ts-node` are usually absent,
# producing a large, misleading failure (e.g. "node: command not found",
# spurious hook-contract failures). The exact same gate passes under Git Bash.
# This wrapper finds Git Bash, refuses to run under WSL bash, fails fast if the
# toolchain is missing, and runs scripts/verify.sh through Git Bash.
#
# Usage:
#   pwsh scripts/verify.ps1            # the gate
#   pwsh scripts/verify.ps1 --e2e      # include E2E (passed through to verify.sh)

$ErrorActionPreference = 'Stop'

# Repo root = parent of this script's directory.
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot  = Split-Path -Parent $ScriptDir

function Find-GitBash {
    # 1) Derive from the resolved `git` executable (most reliable across installs).
    $git = Get-Command git -ErrorAction SilentlyContinue
    if ($git) {
        $gitDir = Split-Path -Parent $git.Source          # ...\Git\cmd  or  ...\Git\bin
        $gitHome = Split-Path -Parent $gitDir              # ...\Git
        foreach ($rel in @('bin\bash.exe', 'usr\bin\bash.exe')) {
            $cand = Join-Path $gitHome $rel
            if (Test-Path $cand) { return $cand }
        }
    }
    # 2) Common fixed install locations.
    foreach ($cand in @(
        "$env:ProgramFiles\Git\bin\bash.exe",
        "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
        "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe"
    )) {
        if ($cand -and (Test-Path $cand)) { return $cand }
    }
    return $null
}

$bash = Find-GitBash
if (-not $bash) {
    Write-Error @"
Could not find Git Bash (bin\bash.exe).
The gate must NOT run under WSL bash (C:\Windows\System32\bash.exe), where node/ts-node are typically unavailable.
Install Git for Windows (https://git-scm.com/download/win), then re-run:  pwsh scripts/verify.ps1
"@
    exit 1
}

# Guard: never let a WSL/System32 bash slip through.
if ($bash -match '(?i)System32\\bash\.exe$') {
    Write-Error "Refusing to run the gate under WSL bash ($bash). Use Git Bash instead."
    exit 1
}

# Toolchain preflight: the most common Windows failure is node missing on PATH
# inside the shell npm spawns. Verify node is reachable from Git Bash itself.
$nodeCheck = & $bash -lc 'command -v node >/dev/null 2>&1 && node -v || echo __NO_NODE__'
if ($nodeCheck -match '__NO_NODE__') {
    Write-Error @"
Git Bash found at: $bash
...but 'node' is not on PATH inside it. Install Node.js and ensure it is on PATH,
then re-run. (This is the root cause of the 'node: command not found' gate failures.)
"@
    exit 1
}
Write-Host "verify.ps1: using Git Bash at $bash (node $nodeCheck)" -ForegroundColor Cyan

# Run the real gate through Git Bash, passing any args (e.g. --e2e) through.
# Use a POSIX path for the script so Git Bash resolves it cleanly.
$argline = ($args | ForEach-Object { "'" + ($_ -replace "'", "'\''") + "'" }) -join ' '
& $bash -lc "cd '$RepoRoot' && bash scripts/verify.sh $argline"
exit $LASTEXITCODE
