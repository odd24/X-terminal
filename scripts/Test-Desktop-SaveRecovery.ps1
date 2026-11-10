$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$root = Split-Path -Parent $PSScriptRoot
$fixtureDirectory = Join-Path $root 'target/save-recovery-fixture'
try {
    & cargo build -p session-service -p mcp-bridge --locked
    if ($LASTEXITCODE -ne 0) { throw 'save recovery sibling build failed' }
    & npm run tauri --workspace apps/desktop -- build --debug --no-bundle --features save-recovery-fixture
    if ($LASTEXITCODE -ne 0) { throw 'save recovery Desktop fixture build failed' }
    New-Item -ItemType Directory -Path $fixtureDirectory -Force | Out-Null
    foreach ($name in @('shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe')) {
        Copy-Item -LiteralPath (Join-Path $root "target/debug/$name") -Destination $fixtureDirectory -Force
    }
    & node (Join-Path $PSScriptRoot 'Test-Desktop-SaveRecovery.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'save recovery Desktop fixture checks failed' }
} finally {
    & npm run desktop:build
    if ($LASTEXITCODE -ne 0) { throw 'ordinary Desktop restoration failed' }
}
& node (Join-Path $PSScriptRoot 'Test-Desktop-SaveRecovery.mjs') --ordinary
if ($LASTEXITCODE -ne 0) { throw 'ordinary save recovery checks failed' }
& node (Join-Path $PSScriptRoot 'Test-Desktop-Save.mjs')
if ($LASTEXITCODE -ne 0) { throw 'ordinary native save regression failed' }
