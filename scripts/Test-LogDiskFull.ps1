$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$logDiskFullRepo = Split-Path -Parent $PSScriptRoot
try {
    & cargo test -p session-service --locked --test windows_ipc --features log-disk-full-fixture -- logging_cases::ssh_log_disk_full_preserves_synced_prefix_and_requires_explicit_restart --exact --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'log disk-full service IPC check failed' }
} finally {
    & cargo build -p session-service --locked
    if ($LASTEXITCODE -ne 0) { throw 'ordinary service restoration failed' }
}

$logDiskFullStart = [System.Diagnostics.ProcessStartInfo]::new()
$logDiskFullStart.FileName = Join-Path $logDiskFullRepo 'target/debug/session-service.exe'
$logDiskFullStart.UseShellExecute = $false
$logDiskFullStart.CreateNoWindow = $true
$logDiskFullStart.RedirectStandardError = $true
$logDiskFullStart.ArgumentList.Add('--log-disk-full-fixture')
$logDiskFullProbe = [System.Diagnostics.Process]::Start($logDiskFullStart)
try {
    if (!$logDiskFullProbe.WaitForExit(10000)) {
        $logDiskFullProbe.Kill()
        throw 'ordinary disk-full fixture refusal timed out'
    }
    if ($logDiskFullProbe.ExitCode -eq 0 -or !$logDiskFullProbe.StandardError.ReadToEnd().Contains('LOG_DISK_FULL_FIXTURE_DISABLED')) {
        throw 'ordinary service must explicitly reject disk-full fixture mode'
    }
} finally {
    $logDiskFullProbe.Dispose()
}
Write-Output 'PASS ordinary service rebuilt and disk-full fixture parameter refused.'
