<#
.SYNOPSIS
    The Continuous Autonomous Power Loop Substrate.
.DESCRIPTION
    Runs indefinitely, executing a human-specified LLM engine command string, 
    enforcing BIOS security checks, and running local validation gates.
.PARAMETER ExecuteCommand
    The exact command line execution string used to invoke the LLM agent engine.
#>
param (
    [Parameter(Mandatory=$true, Position=0)]
    [string]$ExecuteCommand
)

Write-Host "[POWER] Power Grid Active. Starting autonomous loop..." -ForegroundColor Green
Write-Host "[POWER] Command payload locked: $ExecuteCommand" -ForegroundColor Yellow

while ($true) {
    Write-Host "`n--- [New Iteration Loop Tick] ---" -ForegroundColor Cyan

    # 1. Run the BIOS Check via an isolated file engine wrapper
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/assert-gate-integrity.ps1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Execution halted due to integrity failure."
        break
    }

    # 2. Fire up the LLM Operating System using the dynamic command string via cmd /c
    Write-Host "[ENGINE] Awakening LLM Runtime Engine..." -ForegroundColor Magenta
    
    # Executing via cmd /c preserves nested double quotes flawlessly on Windows
    cmd.exe /c $ExecuteCommand
    
    # Capture the engine's exit status immediately
    $EngineExitCode = $LASTEXITCODE
    Write-Host "[ENGINE] Execution cycle complete. Exit Code: $EngineExitCode" -ForegroundColor Gray
    
    # 3. Force the validation gate to run inside an isolated wrapper
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/local-gate.ps1
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[FAIL] Validation failed. Forcing state rollback to protect main..." -ForegroundColor Red
        git reset --hard HEAD
        git clean -fd
    } else {
        Write-Host "[VERIFIED] Iteration verified clean." -ForegroundColor Green
    }

    # Rest the processor briefly before the next machine cycle
    Start-Sleep -Seconds 2
}