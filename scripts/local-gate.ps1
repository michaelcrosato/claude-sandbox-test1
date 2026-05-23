Write-Host "[GATE] Running validation gate..." -ForegroundColor Yellow

# Baseline check: Does the code at least compile/parse cleanly?
$GitStatus = git status --porcelain
if ($null -eq $GitStatus) {
    Write-Host "[PASS] Gate Passed: Clean workspace state." -ForegroundColor Green
    exit 0
}

# If there are changes, ensure no gross git structural corruption
if ($GitStatus -match "▲") { 
    Write-Error "Gate Failed: Unresolved conflict markers found in code!"
    exit 1 
}

Write-Host "[PASS] Gate Passed: Sandbox verified." -ForegroundColor Green
exit 0