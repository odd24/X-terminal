$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
try {
    & cargo test -p session-service --locked --test windows_ipc --features serial-mcp-fixture -- agent_cases::forms_cases::serial_forms::serial_driver_read_error_retires_agent_but_preserves_observer_prefix --exact --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'serial read failure service IPC check failed' }
} finally {
    & cargo build -p session-service --locked
    if ($LASTEXITCODE -ne 0) { throw 'ordinary service restoration failed' }
}
& node (Join-Path $PSScriptRoot 'Test-SerialMcpFixtureGuards.mjs') --ordinary
if ($LASTEXITCODE -ne 0) { throw 'ordinary serial fixture parameter refusal failed' }
