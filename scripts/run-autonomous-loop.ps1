param (
    [Parameter(Mandatory=$true, Position=0)]
    [string]$ExecuteCommand,
    [int]$MaxRetries = 3
)

function Write-TS([string]$msg, [string]$Color="White", [switch]$LogToFile) {
    $ts = Get-Date -Format "HH:mm:ss"
    $FormattedLine = "[$ts] $msg"
    Write-Host $FormattedLine -ForegroundColor $Color
    if ($LogToFile -and (Test-Path "docs/LOG.md")) {
        $LogPath = "docs/LOG.md"
        $Content = Get-Content $LogPath -Raw
        $NewContent = $Content -replace "(== LOG-ANCHOR ==\r?\n)", "`$1$FormattedLine`n"
        [IO.File]::WriteAllText("$PWD\$LogPath", $NewContent)
    }
}

$RunId = Get-Date -Format "yyyyMMdd-HHmmss"
Write-TS "Autonomous Substrate initialized — run $RunId" "Cyan"
Write-TS "maxRetries=$MaxRetries  dryRun=False" "DarkGray"

$Attempt = 1
while ($true) {
    $CurrentTicket = "SYSTEM"
    $QueueStr = "EMPTY"

    if (Test-Path "docs/TICKETS.md") {
        $Lines = Get-Content "docs/TICKETS.md" -ErrorAction SilentlyContinue
        $Pending = $Lines | Where-Object { $_ -match "^###\s+T-\w+" } | ForEach-Object { ($_ -replace "^###\s+", "").Trim() }
        if ($Pending) {
            $CurrentTicket = ($Pending[0] -split ' ')[0]
            $QueueStr = ($Pending | ForEach-Object { ($_ -split ' ')[0] }) -join ", "
        }
    }

    if ($Attempt -eq 1) { 
        Write-TS "Queue: $QueueStr" "DarkGray" 
        Write-TS "==== $CurrentTicket ====" "Magenta"
    }

    Write-TS "attempt $Attempt/$MaxRetries — invoking agent ..." "Yellow"

    # Silence integrity checker unless it encounters an actual structural block
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/assert-gate-integrity.ps1 *> integrity-runtime.log
    if ($LASTEXITCODE -ne 0) { 
        Get-Content integrity-runtime.log -ErrorAction SilentlyContinue | Write-Host -ForegroundColor Red
        Write-TS "Execution halted due to substrate integrity failure." "Red" -LogToFile
        break 
    }

    $StartTime = Get-Date
    
    # ─── SILENCE AGENT LOGS ──────────────────────────────────────────────────
    # Redirects all noise from the frontier LLM engine execution into a log file
    cmd.exe /c $ExecuteCommand *> agent-runtime.log
    $EngineExitCode = $LASTEXITCODE
    $Duration = [math]::Round(((Get-Date) - $StartTime).TotalSeconds)
    
    if ($EngineExitCode -eq 0) { $Reason = "completed" } else { $Reason = "error" }
    Write-TS "agent done: duration=${Duration}s isError=$($EngineExitCode -ne 0) reason=$Reason" "DarkGray"

    Write-TS "running verify gate (source of truth) ..." "DarkGray"
    
    # ─── SILENCE VERIFICATION GATE ───────────────────────────────────────────
    # Redirects the sprawling test suites/linter outputs out of your screen
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/local-gate.ps1 *> gate-runtime.log
    $GateExitCode = $LASTEXITCODE
    
    if ($GateExitCode -ne 0) {
        Write-TS "$CurrentTicket — verify RED on attempt $Attempt." "Red" -LogToFile
        
        # NOTE: If you ever want failing test summaries to dump to the screen 
        # on a failure, you can uncomment the line below:
        # Get-Content gate-runtime.log -ErrorAction SilentlyContinue | Write-Host -ForegroundColor DarkRed
        
        git reset --hard HEAD 2>&1 | Out-Null
        git clean -fd 2>&1 | Out-Null
        $Attempt++
        if ($Attempt -gt $MaxRetries) {
            Write-TS "Max retries ($MaxRetries) reached for $CurrentTicket. Halting system." "Red" -LogToFile
            break
        }
    } else {
        Write-TS "$CurrentTicket — verify GREEN on attempt $Attempt." "Green" -LogToFile
        $Attempt = 1
    }

    if (Test-Path "docs/GOAL.md") {
        if ((Get-Content "docs/GOAL.md" -Raw) -match "CURRENT_STATE:\s*BOOTSTRAP") {
            Write-TS "[PAUSED] Blueprint generated. Switch GOAL.md to ACTIVE_SPECIFICATION to resume." "Cyan"
            break
        }
    }
    Start-Sleep -Seconds 2
}