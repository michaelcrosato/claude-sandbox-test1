Write-Host "[POWER] Power Grid Active. Starting autonomous loop..." -ForegroundColor Green

while ($true) {
    Write-Host "`n--- [New Iteration Loop Tick] ---" -ForegroundColor Cyan

    # 1. Run the BIOS Check via an isolated file engine wrapper
    powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/assert-gate-integrity.ps1
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Execution halted due to integrity failure."
        break
    }

    # 2. Fire up the LLM Operating System
    Write-Host "[ENGINE] Awakening LLM Runtime Engine..." -ForegroundColor Magenta
    
    # NOTE: Replace this line with your actual CLI execution call 
    # Invoke-LLM -PromptFiles "docs/AXIOMS.md", "docs/AGENT-LOOP.md", "docs/GOAL.md"
    
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