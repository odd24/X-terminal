param([string]$DataRoot, [string]$ReportRoot)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
Add-Type -Path (Join-Path $PSScriptRoot 'LoadSoakSnapshot.cs')
$bound = $null
$lastId = 0
$count = 0
[Console]::WriteLine('{"id":0,"ready":true}')
while ($null -ne ($line = [Console]::ReadLine())) {
  $stage = 'request'
  $id = $null
  $allocated = @()
  try {
    if ($line.Length -gt 2048 -or ++$count -gt 3000) { throw 'request bound' }
    $request = $line | ConvertFrom-Json -AsHashtable
    $id = $request.id
    if ($id -isnot [long] -and $id -isnot [int]) { throw 'invalid id' }
    if ($id -le $lastId) { throw 'out of order' }
    $lastId = $id
    if ($request.op -eq 'stop' -and $request.Count -eq 2) {
      [Console]::WriteLine((@{id=$id;stopped=$true} | ConvertTo-Json -Compress))
      break
    }
    if ($request.op -notin 'preflight','sample') { throw 'invalid operation' }
    $expected = if ($request.op -eq 'sample') {5} else {2}
    if ($request.Count -ne $expected) { throw 'invalid fields' }
    $stage = 'system_snapshot'
    $memory = [LoadSoakSnapshot]::Memory()
    $commit = [LoadSoakSnapshot]::SystemCommit()
    $report = @{
      available=$memory[1]; memory=$memory[0]; os=[Environment]::OSVersion.VersionString
      systemCommitBytes=if ($null -ne $commit) { @{ used=$commit[0]; limit=$commit[1] } } else { $null }
      cores=[Environment]::ProcessorCount
      power=[string][System.Windows.Forms.SystemInformation]::PowerStatus.PowerLineStatus
      free=@($DataRoot,$ReportRoot | ForEach-Object {
        [IO.DriveInfo]::new([IO.Path]::GetPathRoot($_)).AvailableFreeSpace
      })
    }
    if ($request.op -eq 'preflight') {
      $stage = 'power_preflight'
      $report.acTimers = @(foreach ($setting in 'STANDBYIDLE','HIBERNATEIDLE') {
        $values = @(powercfg /q SCHEME_CURRENT SUB_SLEEP $setting | Select-String '0x[0-9a-f]+\s*$')
        if ($LASTEXITCODE -ne 0 -or $values.Count -lt 2) { throw 'power query' }
        [Convert]::ToUInt32(($values[-2].Matches[0].Value.Trim() -replace '^0x',''),16)
      })
    } else {
      $stage = 'process_snapshot'
      $owned = @{}
      foreach ($name in 'desktop','service','fixture') {
        $number = $request[$name]
        if (($number -isnot [long] -and $number -isnot [int]) -or $number -le 0) { throw 'invalid pid' }
        $owned[$name] = Get-Process -Id $number
        $allocated += $owned[$name]
      }
      $identity = @($owned.desktop,$owned.service,$owned.fixture | ForEach-Object {
        "$($_.Id)/$($_.StartTime.ToUniversalTime().Ticks)"
      }) -join ','
      if ($null -ne $bound -and $identity -ne $bound) { throw 'owned process replaced' }
      $bound = $identity
      $tree = [LoadSoakSnapshot]::Processes()
      $descendants = @(@{Pid=$owned.desktop.Id; Created=$owned.desktop.StartTime})
      $webview = @()
      for ($i=0; $i -lt $descendants.Count; $i++) {
        $parent = $descendants[$i]
        foreach ($child in @($tree | Where-Object Parent -EQ $parent.Pid)) {
          $process = Get-Process -Id $child.Pid
          $allocated += $process
          if ($process.StartTime -lt $parent.Created) { continue }
          $descendants += @{Pid=$process.Id; Created=$process.StartTime}
          if ($child.Name -ieq 'msedgewebview2.exe') { $webview += $process }
        }
      }
      if ($webview.Count -eq 0 -or $owned.service.Id -notin $descendants.Pid) { throw 'owned tree incomplete' }
      $sampler = Get-Process -Id $PID
      $allocated += $sampler
      $groups = @{desktop=@($owned.desktop);service=@($owned.service);fixture=@($owned.fixture);webview=$webview;sampler=@($sampler)}
      $report.processes = @{}
      foreach ($name in $groups.Keys) {
        $items = @($groups[$name])
        $report.processes[$name] = @{
          count=$items.Count
          private=($items | Measure-Object PrivateMemorySize64 -Sum).Sum
          working=($items | Measure-Object WorkingSet64 -Sum).Sum
          handles=($items | Measure-Object HandleCount -Sum).Sum
          cpu=($items | Measure-Object CPU -Sum).Sum
        }
      }
    }
    $response = @{id=$id;result=$report} | ConvertTo-Json -Depth 6 -Compress
    if ($response.Length -gt 16384) { throw 'response bound' }
    [Console]::WriteLine($response)
  } catch {
    [Console]::WriteLine((@{id=$id;failure=$stage} | ConvertTo-Json -Compress))
    exit 1
  } finally {
    foreach ($process in $allocated) { $process.Dispose() }
  }
}
