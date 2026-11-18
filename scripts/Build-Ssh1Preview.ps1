$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Enter-Toolchain.ps1')
Push-Location (Join-Path $PSScriptRoot '..')
try {
    npm run desktop:build
    if ($LASTEXITCODE -ne 0) { throw 'Desktop build failed' }
    $build = & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'Build-Ssh1Helper.ps1') -WithService
    $status = $LASTEXITCODE
    $build | Write-Host
    if ($status -ne 0) { throw 'Paired SSH1 helper and service build failed' }
    $result = @($build | Where-Object { $_ -like 'SSH1_SERVICE=*' })
    if ($result.Count -ne 1) { throw 'Exactly one paired service build is required' }
    $service = $result[0].Substring('SSH1_SERVICE='.Length)
    node scripts/Prepare-Local-Preview.mjs --ssh1-service $service
    if ($LASTEXITCODE -ne 0) { throw 'SSH1 preview smoke failed' }
} finally {
    Pop-Location
}
