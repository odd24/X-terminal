$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/Enter-Toolchain.ps1"
$auditRepoRoot = Split-Path -Parent $PSScriptRoot
$auditFixtureRoot = Join-Path $auditRepoRoot 'target/audit-diagnostic-fixture'
try {
    & cargo build -p session-service --bin session-service --example audit_diagnostic_probe --features audit-diagnostics-fixture --locked
    if ($LASTEXITCODE -ne 0) { throw 'audit diagnostic fixture build failed' }
    New-Item -ItemType Directory -Path $auditFixtureRoot -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $auditRepoRoot 'target/debug/session-service.exe') -Destination (Join-Path $auditFixtureRoot 'session-service.exe') -Force
    & (Join-Path $auditRepoRoot 'target/debug/examples/audit_diagnostic_probe.exe')
    if ($LASTEXITCODE -ne 0) { throw 'finite audit diagnostic probes failed; retain evidence' }
} finally {
    & npm run desktop:build
    if ($LASTEXITCODE -ne 0) { throw 'ordinary actual Desktop/service restoration failed' }
}
$auditStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$auditStartInfo.FileName = Join-Path $auditRepoRoot 'target/debug/session-service.exe'
$auditStartInfo.UseShellExecute = $false
$auditStartInfo.CreateNoWindow = $true
$auditStartInfo.RedirectStandardError = $true
$auditStartInfo.RedirectStandardOutput = $true
$auditStartInfo.ArgumentList.Add('--audit-diagnostic-fixture')
$auditStartInfo.ArgumentList.Add('normal')
$auditOrdinaryProbe = [System.Diagnostics.Process]::Start($auditStartInfo)
try {
    if (-not $auditOrdinaryProbe.WaitForExit(10000)) { $auditOrdinaryProbe.Kill(); throw 'ordinary diagnostic parameter rejection timed out' }
    $auditProbeError = $auditOrdinaryProbe.StandardError.ReadToEnd()
    if ($auditOrdinaryProbe.ExitCode -eq 0 -or -not $auditProbeError.Contains('AUDIT_DIAGNOSTIC_FIXTURE_DISABLED')) { throw 'ordinary service must explicitly reject diagnostic fixture parameter' }
} finally { $auditOrdinaryProbe.Dispose() }
& node (Join-Path $PSScriptRoot 'Test-AuditDiagnosticNormal.mjs')
if ($LASTEXITCODE -ne 0) { throw 'ordinary Desktop runtime probe failed' }
Write-Output 'PASS finite diagnostic service cases, actual ordinary build, default parameter refusal and ordinary Desktop runtime.'
