$ManifestPath = "scripts/manifest.txt"
if (-not (Test-Path $ManifestPath)) {
    Write-Error "CRITICAL: Integrity manifest missing. Run init-repo.ps1 first."
    exit 1
}

$Lines = Get-Content -Path $ManifestPath
foreach ($Line in $Lines) {
    if ($Line -match "(.+):(.+)") {
        $File = $Matches[1]
        $ExpectedHash = $Matches[2]
        
        if (-not (Test-Path $File)) {
            Write-Error "CRITICAL SECURITY BREACH: Protected file $File has been DELETED!"
            exit 1
        }
        
        $CurrentHash = (Get-FileHash -Path $File -Algorithm SHA256).Hash
        if ($CurrentHash -ne $ExpectedHash) {
            Write-Error "CRITICAL SECURITY BREACH: Protected file $File has been TAMPERED WITH!"
            exit 1
        }
    }
}
exit 0