$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
& npm run tauri --workspace apps/desktop -- build --debug --no-bundle --features load-observer-test
if ($LASTEXITCODE -ne 0) { throw 'test feature actual Desktop build failed' }
$observerBuildRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'target/load-observer-test'
New-Item -ItemType Directory -Path $observerBuildRoot -Force | Out-Null
foreach ($observerBinary in @('shared-terminal-desktop.exe', 'session-service.exe', 'terminal-mcp.exe')) {
    Copy-Item -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) "target/debug/$observerBinary") -Destination (Join-Path $observerBuildRoot $observerBinary) -Force
}
& npm run desktop:build
if ($LASTEXITCODE -ne 0) { throw 'ordinary Desktop actual build restoration failed' }
Write-Output "Test-only Desktop isolated at $observerBuildRoot; ordinary Desktop build restored."
