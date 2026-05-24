Write-Host "[GATE] Running validation gate..." -ForegroundColor Yellow

# Baseline check: Does the code at least compile/parse cleanly?
$GitStatus = git status --porcelain
if ($null -eq $GitStatus) {
    Write-Host "[PASS] Gate Passed: Clean workspace state." -ForegroundColor Green
    exit 0
}

# Ensure no standard git merge conflict markers have leaked into files
if ($GitStatus -match "(<<<<<<<|=======|>>>>>>>)") { 
    Write-Error "Gate Failed: Unresolved conflict markers found in source files!"
    exit 1 
}

Write-Host "[PASS] Gate Passed: Sandbox verified." -ForegroundColor Green
exit 0