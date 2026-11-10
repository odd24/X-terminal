$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
& npm run desktop:build
if ($LASTEXITCODE -ne 0) {throw 'ordinary Desktop build failed'}
& (Join-Path $PSScriptRoot 'Test-Desktop-McpSerial.ps1') -Connect
