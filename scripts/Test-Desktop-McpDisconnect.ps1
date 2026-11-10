$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
& npm run desktop:build
if ($LASTEXITCODE -ne 0) {throw 'ordinary Desktop build failed'}
& cargo build -p session-service --example gui_ssh_fixture --locked
if ($LASTEXITCODE -ne 0) {throw 'synthetic SSH fixture build failed'}
& node (Join-Path $PSScriptRoot 'Test-Desktop-Mcp.mjs') --disconnect
if ($LASTEXITCODE -ne 0) {throw 'real SSH2 MCP disconnect checks failed'}
& (Join-Path $PSScriptRoot 'Test-Desktop-McpSerial.ps1') -Disconnect
