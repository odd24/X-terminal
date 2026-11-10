$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$closeRepoRoot = Split-Path -Parent $PSScriptRoot
$closeFixtureDirectory = Join-Path $closeRepoRoot 'target/desktop-close-receipt-fixture'
try {
    & cargo build -p session-service --bin session-service --features audit-diagnostics-fixture --locked
    if ($LASTEXITCODE -ne 0) { throw 'close receipt service fixture build failed' }
    New-Item -ItemType Directory -Path $closeFixtureDirectory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $closeRepoRoot 'target/debug/session-service.exe') -Destination $closeFixtureDirectory -Force
    Copy-Item -LiteralPath (Join-Path $closeRepoRoot 'target/debug/terminal-mcp.exe') -Destination $closeFixtureDirectory -Force
    & npm run tauri --workspace apps/desktop -- build --debug --no-bundle --features close-receipt-fixture
    if ($LASTEXITCODE -ne 0) { throw 'close receipt native fixture actual build failed' }
    Copy-Item -LiteralPath (Join-Path $closeRepoRoot 'target/debug/shared-terminal-desktop.exe') -Destination $closeFixtureDirectory -Force
    & node (Join-Path $PSScriptRoot 'Test-Desktop-CloseReceipts.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'close receipt native lifecycle test failed' }
} finally {
    & npm run desktop:build
    if ($LASTEXITCODE -ne 0) { throw 'ordinary actual desktop/service restoration failed' }
}
& node (Join-Path $PSScriptRoot 'Test-AuditDiagnosticNormal.mjs')
if ($LASTEXITCODE -ne 0) { throw 'ordinary runtime restoration probe failed' }
& node (Join-Path $PSScriptRoot 'Test-Desktop-CloseReceipts.mjs') --ordinary
if ($LASTEXITCODE -ne 0) { throw 'ordinary close receipt lifecycle probe failed' }
