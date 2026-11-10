param([Parameter(Mandatory=$true)][int]$TargetProcessId,[Parameter(Mandatory=$true)][ValidateRange(640,2000)][int]$Width,[Parameter(Mandatory=$true)][ValidateRange(480,1400)][int]$Height,[string]$ExpectedExecutable,[switch]$MeasureOnly,[switch]$PhysicalSize)
$ErrorActionPreference='Stop'
if (($MeasureOnly -or $PhysicalSize) -and !$ExpectedExecutable) { throw 'Physical test measurements require an expected executable' }
$targetProcess=Get-Process -Id $TargetProcessId
if ([System.IO.Path]::GetFileName($targetProcess.Path) -ne 'shared-terminal-desktop.exe') { throw 'Unexpected test window process' }
$targetHandle=$targetProcess.MainWindowHandle
if ($targetHandle -eq [IntPtr]::Zero) { throw 'No self-test main window' }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TerminalTestWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor,Work; public uint Flags; }
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetClientRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
}
"@
if ($ExpectedExecutable) {
 if ($targetProcess.Path -ne (Resolve-Path -LiteralPath $ExpectedExecutable).ProviderPath) { throw 'Test window executable does not match its owned preview' }
 [uint32]$owner=0
 if (-not [TerminalTestWindow]::GetWindowThreadProcessId($targetHandle,[ref]$owner) -or $owner -ne $TargetProcessId) { throw 'Test window handle is not owned by the expected PID' }
 $previous=[TerminalTestWindow]::SetThreadDpiAwarenessContext([IntPtr](-4))
 if ($previous -eq [IntPtr]::Zero) { throw 'Physical window measurement requires a per-monitor DPI aware caller' }
 try {
  $dpi=[TerminalTestWindow]::GetDpiForWindow($targetHandle)
  if (-not $dpi) { throw 'Test window DPI query failed' }
  $physicalWidth=if ($PhysicalSize) { $Width } else { [int][Math]::Ceiling($Width*$dpi/96) }
  $physicalHeight=if ($PhysicalSize) { $Height } else { [int][Math]::Ceiling($Height*$dpi/96) }
  $monitor=[TerminalTestWindow]::MonitorFromWindow($targetHandle,2)
  $info=New-Object TerminalTestWindow+MonitorInfo
  $info.Size=[Runtime.InteropServices.Marshal]::SizeOf($info)
  if (-not [TerminalTestWindow]::GetMonitorInfo($monitor,[ref]$info)) { throw 'Test monitor work area query failed' }
  $rect=New-Object TerminalTestWindow+Rect
  if (-not [TerminalTestWindow]::GetWindowRect($targetHandle,[ref]$rect)) { throw 'Initial test window rectangle query failed' }
  $originInWorkArea=$rect.Left -ge $info.Work.Left -and $rect.Top -ge $info.Work.Top -and $rect.Left -lt $info.Work.Right -and $rect.Top -lt $info.Work.Bottom
  $availableWidth=if ($originInWorkArea) { $info.Work.Right-$rect.Left } else { 0 }
  $availableHeight=if ($originInWorkArea) { $info.Work.Bottom-$rect.Top } else { 0 }
  if (!$MeasureOnly) {
   if ($physicalWidth -gt $availableWidth -or $physicalHeight -gt $availableHeight) { throw 'Requested test window would not fit at its current position' }
   if (-not [TerminalTestWindow]::SetWindowPos($targetHandle,[IntPtr]::Zero,0,0,$physicalWidth,$physicalHeight,22)) { throw 'Self-test resize failed' }
  }
  $client=New-Object TerminalTestWindow+Rect
  $targetProcess.Refresh()
  if ($targetProcess.MainWindowHandle -ne $targetHandle -or -not [TerminalTestWindow]::GetWindowThreadProcessId($targetHandle,[ref]$owner) -or $owner -ne $TargetProcessId -or [TerminalTestWindow]::GetDpiForWindow($targetHandle) -ne $dpi) { throw 'Test window identity or DPI changed during resize' }
  if (-not [TerminalTestWindow]::GetWindowRect($targetHandle,[ref]$rect) -or -not [TerminalTestWindow]::GetClientRect($targetHandle,[ref]$client)) { throw 'Resized test window geometry query failed' }
  @{
   pid=$owner; hwnd=('0x{0:X}' -f $targetHandle.ToInt64()); dpi=$dpi
   width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top
   requestedWidth=$physicalWidth; requestedHeight=$physicalHeight
   clientWidth=$client.Right-$client.Left; clientHeight=$client.Bottom-$client.Top
   displayWidth=$info.Monitor.Right-$info.Monitor.Left; displayHeight=$info.Monitor.Bottom-$info.Monitor.Top
   workWidth=$info.Work.Right-$info.Work.Left; workHeight=$info.Work.Bottom-$info.Work.Top
   availableWidth=$availableWidth; availableHeight=$availableHeight
  } | ConvertTo-Json -Compress
 } finally { [void][TerminalTestWindow]::SetThreadDpiAwarenessContext($previous) }
 return
}
if (-not [TerminalTestWindow]::SetWindowPos($targetHandle,[IntPtr]::Zero,0,0,$Width,$Height,22)) { throw 'Self-test resize failed' }
$targetRect=New-Object TerminalTestWindow+Rect
if (-not [TerminalTestWindow]::GetWindowRect($targetHandle,[ref]$targetRect)) { throw 'Self-test rectangle failed' }
@{width=$targetRect.Right-$targetRect.Left;height=$targetRect.Bottom-$targetRect.Top}|ConvertTo-Json -Compress
