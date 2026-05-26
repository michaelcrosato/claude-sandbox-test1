Write-Host "[GATE] Running validation gate..." -ForegroundColor Yellow

# 1. Ensure no standard git merge conflict markers have leaked into files
$GitStatus = git status --porcelain
if ($GitStatus -match "(<<<<<<<|=======|>>>>>>>)") { 
    Write-Error "Gate Failed: Unresolved conflict markers found in source files!"
    exit 1 
}

# 2. Dynamic Invariant Testing (Agent-Owned Domain)
# The agent is responsible for building and maintaining this file.
$TestScript = "scripts/run-tests.ps1"
if (Test-Path $TestScript) {
    Write-Host "[GATE] Executing project-specific invariant tests ($TestScript)..." -ForegroundColor Cyan
    
    # Execute the agent's test script
    powershell -NoProfile -ExecutionPolicy Bypass -File $TestScript
    
    if ($LASTEXITCODE -ne 0) {
        Write-Error "Gate Failed: Invariant test suite returned a non-zero exit code!"
        exit 1
    }
} else {
    Write-Host "[GATE] No project-specific test script found at $TestScript. Skipping invariant checks." -ForegroundColor DarkGray
}

Write-Host "[PASS] Gate Passed: Sandbox verified clean." -ForegroundColor Green
exit 0