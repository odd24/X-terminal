param(
  [int]$DesktopPid,
  [int]$ServicePid,
  [int]$FixturePid,
  [string]$DataRoot,
  [string]$ReportRoot,
  [switch]$Preflight
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$os = Get-CimInstance Win32_OperatingSystem
$report = @{
  available = [uint64]$os.FreePhysicalMemory * 1024
  memory = [uint64]$os.TotalVisibleMemorySize * 1024
  os = $os.Caption
  cores = [Environment]::ProcessorCount
  power = [string][System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus
  free = @($DataRoot, $ReportRoot | ForEach-Object {
    [IO.DriveInfo]::new([IO.Path]::GetPathRoot($_)).AvailableFreeSpace
  })
}
if ($Preflight) {
  $report.acTimers = @(foreach ($setting in 'STANDBYIDLE', 'HIBERNATEIDLE') {
    $values = @(powercfg /q SCHEME_CURRENT SUB_SLEEP $setting | Select-String '0x[0-9a-f]+\s*$')
    if ($LASTEXITCODE -ne 0 -or $values.Count -lt 2) { throw 'Cannot verify AC power timer' }
    [Convert]::ToUInt32(($values[-2].Matches[0].Value.Trim() -replace '^0x',''), 16)
  })
} else {
  $tree = @(Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CreationDate)
  $desktop = $tree | Where-Object ProcessId -EQ $DesktopPid
  if (-not $desktop) { throw 'Owned Desktop exited' }
  $descendants = @($desktop)
  for ($i = 0; $i -lt $descendants.Count; $i++) {
    $parent = $descendants[$i]
    $descendants += @($tree | Where-Object {
      $_.ParentProcessId -eq $parent.ProcessId -and $_.CreationDate -ge $parent.CreationDate
    })
  }
  $webview = @($descendants | Where-Object Name -EQ 'msedgewebview2.exe')
  if ($webview.Count -eq 0 -or $ServicePid -notin $descendants.ProcessId) { throw 'Owned process tree changed' }
  $report.processes = @{}
  foreach ($entry in @(
    @{ name = 'desktop'; ids = @($DesktopPid) },
    @{ name = 'service'; ids = @($ServicePid) },
    @{ name = 'fixture'; ids = @($FixturePid) },
    @{ name = 'webview'; ids = @($webview.ProcessId) }
  )) {
    $items = @(Get-Process -Id $entry.ids)
    $report.processes[$entry.name] = @{
      count = $items.Count
      private = ($items | Measure-Object PrivateMemorySize64 -Sum).Sum
      working = ($items | Measure-Object WorkingSet64 -Sum).Sum
      handles = ($items | Measure-Object HandleCount -Sum).Sum
      cpu = ($items | Measure-Object CPU -Sum).Sum
    }
  }
}
$report | ConvertTo-Json -Depth 5 -Compress
