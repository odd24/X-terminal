$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
try {
    & cargo build -p session-service --example gui_ssh_fixture --locked
    if ($LASTEXITCODE -ne 0) { throw 'SSH exec fixture build failed' }
    & node (Join-Path $PSScriptRoot 'Test-Desktop-Mcp.mjs') --exec
    if ($LASTEXITCODE -ne 0) { throw 'real SSH exec stdio checks failed' }
} finally {
    & cargo build -p session-service --bin session-service --locked
    if ($LASTEXITCODE -ne 0) { throw 'ordinary service restoration failed' }
}
& node (Join-Path $PSScriptRoot 'Test-AuditDiagnosticNormal.mjs')
if ($LASTEXITCODE -ne 0) { throw 'ordinary restored runtime checks failed' }
