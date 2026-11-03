$ErrorActionPreference = 'Stop'
$repoDir = Split-Path -Parent $PSScriptRoot
$puttyDir = Join-Path $repoDir '.tools/putty'
New-Item -ItemType Directory -Force -Path $puttyDir | Out-Null
$destination = Join-Path $puttyDir 'plink.exe'
if (-not (Test-Path -LiteralPath $destination)) {
    Invoke-WebRequest 'https://the.earth.li/~sgtatham/putty/0.85/w64/plink.exe' -OutFile $destination
}
$expected = '969F36879D5716AA1A9811F43A6A6510E8F08372DBEB9695B810B9C776F39C75'
if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash -ne $expected) {
    throw 'Plink SHA256 mismatch; refusing to execute. Inspect download before proceeding.'
}
& $destination -V
if ($LASTEXITCODE -ne 0) { throw 'Plink version probe failed' }
