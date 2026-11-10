param([switch]$Disconnect)
$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$serialRepoRoot=Split-Path -Parent $PSScriptRoot
$serialFixtureDirectory=Join-Path $serialRepoRoot 'target/serial-mcp-fixture'
try {
    & cargo build -p session-service --bin session-service --features serial-mcp-fixture --locked
    if ($LASTEXITCODE -ne 0) {throw 'serial MCP fixture service build failed'}
    New-Item -ItemType Directory -Path $serialFixtureDirectory -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $serialRepoRoot 'target/debug/session-service.exe') -Destination $serialFixtureDirectory -Force
    Copy-Item -LiteralPath (Join-Path $serialRepoRoot 'target/debug/terminal-mcp.exe') -Destination $serialFixtureDirectory -Force
    & npm run tauri --workspace apps/desktop -- build --debug --no-bundle --features serial-mcp-fixture
    if ($LASTEXITCODE -ne 0) {throw 'serial MCP fixture Desktop actual build failed'}
    Copy-Item -LiteralPath (Join-Path $serialRepoRoot 'target/debug/shared-terminal-desktop.exe') -Destination $serialFixtureDirectory -Force
    & node (Join-Path $PSScriptRoot 'Test-SerialMcpFixtureGuards.mjs')
    if ($LASTEXITCODE -ne 0) {throw 'explicit serial fixture guards failed'}
    $serialTestArgs = if ($Disconnect) { @('--serial', '--disconnect') } else { @('--serial-control') }
    & node (Join-Path $PSScriptRoot 'Test-Desktop-Mcp.mjs') @serialTestArgs
    if ($LASTEXITCODE -ne 0) {throw 'real serial MCP checks failed'}
    if ($Disconnect) {
        & node (Join-Path $PSScriptRoot 'Test-Desktop-Mcp.mjs') --serial-control
        if ($LASTEXITCODE -ne 0) {throw 'serial byte/control regression failed'}
    }
} finally {
    & npm run desktop:build
    if ($LASTEXITCODE -ne 0) {throw 'ordinary Desktop/service actual restoration failed'}
}
& node (Join-Path $PSScriptRoot 'Test-AuditDiagnosticNormal.mjs')
if ($LASTEXITCODE -ne 0) {throw 'ordinary runtime refusal/health checks failed'}
& node (Join-Path $PSScriptRoot 'Test-SerialMcpFixtureGuards.mjs') --ordinary
if ($LASTEXITCODE -ne 0) {throw 'ordinary serial fixture parameter refusal failed'}
