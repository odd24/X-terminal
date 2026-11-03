# Dot-source this file before cargo/Tauri commands. No persistent PATH changes.
$repoToolRoot = Join-Path (Split-Path -Parent $PSScriptRoot) '.tools'
if (Test-Path (Join-Path $repoToolRoot 'cargo/bin/rustup.exe')) {
    $env:RUSTUP_HOME = Join-Path $repoToolRoot 'rustup'
    $env:CARGO_HOME = Join-Path $repoToolRoot 'cargo'
    $env:PATH = "$(Join-Path $env:CARGO_HOME 'bin');$env:PATH"
}
