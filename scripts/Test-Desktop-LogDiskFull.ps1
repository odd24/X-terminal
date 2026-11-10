$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$repo = Split-Path -Parent $PSScriptRoot
$temp = (Resolve-Path -LiteralPath ([IO.Path]::GetTempPath())).ProviderPath.TrimEnd([IO.Path]::DirectorySeparatorChar)
$fixtureDirectory = Join-Path $temp "shared-terminal-log-disk-full-bin-$([guid]::NewGuid())"
$binaries = @('shared-terminal-desktop.exe', 'session-service.exe', 'terminal-mcp.exe')
$test = Join-Path $PSScriptRoot 'Test-Desktop-BasicLogKeyboard.mjs'

New-Item -ItemType Directory -Path $fixtureDirectory | Out-Null
try {
    & cargo build -p session-service --locked --features log-disk-full-fixture --bin session-service --example gui_ssh_fixture
    if ($LASTEXITCODE -ne 0) { throw 'DiskFull service fixture build failed' }
    & cargo build -p mcp-bridge --locked
    if ($LASTEXITCODE -ne 0) { throw 'Desktop MCP sibling build failed' }
    & npm run tauri --workspace apps/desktop -- build --debug --no-bundle --features log-disk-full-fixture
    if ($LASTEXITCODE -ne 0) { throw 'DiskFull Desktop fixture build failed' }
    foreach ($name in $binaries) {
        Copy-Item -LiteralPath (Join-Path $repo "target/debug/$name") -Destination $fixtureDirectory
    }
    & node $test --disk-full (Join-Path $fixtureDirectory 'shared-terminal-desktop.exe')
    if ($LASTEXITCODE -ne 0) { throw 'DiskFull Desktop checks failed' }
} finally {
    try {
        & npm run desktop:build
        if ($LASTEXITCODE -ne 0) { throw 'Ordinary Desktop restoration failed' }
        & node $test --disk-full-ordinary
        if ($LASTEXITCODE -ne 0) { throw 'Ordinary DiskFull refusal or startup checks failed' }
    } finally {
        $resolved = (Resolve-Path -LiteralPath $fixtureDirectory).ProviderPath
        if ((Split-Path -Parent $resolved) -ne $temp -or (Split-Path -Leaf $resolved) -notlike 'shared-terminal-log-disk-full-bin-*') {
            throw 'Unexpected isolated binary directory'
        }
        foreach ($name in $binaries) {
            $file = Join-Path $resolved $name
            if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file }
        }
        Remove-Item -LiteralPath $resolved
    }
}
