$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$gapRepo = Split-Path -Parent $PSScriptRoot
$gapTarget = Join-Path $gapRepo 'target/serial-mcp-wait-gap-fixture'
$ordinaryService = Join-Path $gapRepo 'target/debug/session-service.exe'

function Invoke-GapCargo([string[]] $CargoArgs) {
    & cargo @CargoArgs
    if ($LASTEXITCODE -ne 0) { throw "Cargo failed with exit code $LASTEXITCODE" }
}

function Assert-GapSwitchRejected($executable, $fixture, $code) {
    $root = Join-Path ([IO.Path]::GetTempPath()) ("shared-terminal-mcp-serial-control-中文-wait-guard-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $root | Out-Null
    $marker = Join-Path $root 'serial-mcp-wait-gap'
    New-Item -ItemType File -Path $marker | Out-Null
    $process = [Diagnostics.Process]::new()
    try {
        $start = $process.StartInfo
        $start.FileName = $executable
        $start.UseShellExecute = $false
        $start.CreateNoWindow = $true
        $start.RedirectStandardError = $true
        foreach ($argument in @('--instance', 'serial-wait-gap-guard')) { $start.ArgumentList.Add($argument) }
        if ($fixture) { $start.ArgumentList.Add('--test-fixture') }
        foreach ($argument in @('--serial-mcp-fixture', '--data-dir', $root)) { $start.ArgumentList.Add($argument) }
        if (!$process.Start()) { throw 'Guard process did not start' }
        if (!$process.WaitForExit(5000)) {
            $process.Kill()
            [void]$process.WaitForExit(2000)
            throw 'Guard did not reject before bootstrap'
        }
        if ($process.ExitCode -eq 0 -or !$process.StandardError.ReadToEnd().Contains($code)) {
            throw "Missing expected fixture rejection $code"
        }
        if (@(Get-ChildItem -LiteralPath $root -Force).Count -ne 1) { throw 'Guard mutated the owned root' }
        Write-Output "PASS $code"
    } finally {
        $process.Dispose()
        Remove-Item -LiteralPath $marker
        if (!(Get-ChildItem -LiteralPath $root -Force)) { [IO.Directory]::Delete($root) }
    }
}

Push-Location $gapRepo
try {
    Invoke-GapCargo @('build', '-p', 'mcp-bridge', '--bin', 'terminal-mcp', '--locked')
    Invoke-GapCargo @('build', '-p', 'session-service', '--bin', 'session-service', '--features', 'serial-mcp-fixture', '--locked')
    New-Item -ItemType Directory -Path $gapTarget -Force | Out-Null
    Copy-Item -LiteralPath $ordinaryService -Destination $gapTarget -Force
    Copy-Item -LiteralPath (Join-Path $gapRepo 'target/debug/terminal-mcp.exe') -Destination $gapTarget -Force
    Assert-GapSwitchRejected (Join-Path $gapTarget 'session-service.exe') $false 'SERIAL_MCP_REQUIRES_FIXTURE'
    Invoke-GapCargo @(
        'test', '-p', 'shared-terminal-desktop', '--bin', 'shared-terminal-desktop',
        '--features', 'serial-mcp-fixture', '--locked', '--',
        'bridge_manager::wait_gap_test::worker_source_gap_reaches_terminal_wait_over_the_native_broker',
        '--exact', '--ignored', '--nocapture'
    )
} finally {
    try {
        Invoke-GapCargo @('build', '-p', 'session-service', '--bin', 'session-service', '--locked')
        Assert-GapSwitchRejected $ordinaryService $true 'SERIAL_MCP_FIXTURE_DISABLED'
    } finally {
        Pop-Location
    }
}
