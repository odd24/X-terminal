param([Parameter(Mandatory=$true)][int]$TargetProcessId,[Parameter(Mandatory=$true)][ValidateRange(640,2000)][int]$Width,[Parameter(Mandatory=$true)][ValidateRange(480,1400)][int]$Height,[string]$ExpectedExecutable,[switch]$MeasureOnly,[switch]$PhysicalSize,[switch]$Maximize,[switch]$CompatibilityDetails)
$ErrorActionPreference='Stop'
if (($MeasureOnly -or $PhysicalSize -or $Maximize) -and !$ExpectedExecutable) { throw 'Physical test measurements require an expected executable' }
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
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint threadId);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h,int attribute,out Rect r,int size);
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
  if ($Maximize -and !$MeasureOnly) {
   if (-not [TerminalTestWindow]::ShowWindowAsync($targetHandle,3)) { throw 'Normal test window maximization failed' }
   for ($attempt=0; $attempt -lt 100 -and ![TerminalTestWindow]::IsZoomed($targetHandle); $attempt++) { Start-Sleep -Milliseconds 20 }
   if (-not [TerminalTestWindow]::IsZoomed($targetHandle)) { throw 'Test window did not enter the normal maximized state' }
  } elseif (!$MeasureOnly) {
   if ($physicalWidth -gt $availableWidth -or $physicalHeight -gt $availableHeight) { throw 'Requested test window would not fit at its current position' }
   if (-not [TerminalTestWindow]::SetWindowPos($targetHandle,[IntPtr]::Zero,0,0,$physicalWidth,$physicalHeight,22)) { throw 'Self-test resize failed' }
  }
  $client=New-Object TerminalTestWindow+Rect
  $targetProcess.Refresh()
  if ($targetProcess.MainWindowHandle -ne $targetHandle -or -not [TerminalTestWindow]::GetWindowThreadProcessId($targetHandle,[ref]$owner) -or $owner -ne $TargetProcessId -or [TerminalTestWindow]::GetDpiForWindow($targetHandle) -ne $dpi) { throw 'Test window identity or DPI changed during resize' }
  if (-not [TerminalTestWindow]::GetWindowRect($targetHandle,[ref]$rect) -or -not [TerminalTestWindow]::GetClientRect($targetHandle,[ref]$client)) { throw 'Resized test window geometry query failed' }
  $measurement=@{
   pid=$owner; hwnd=('0x{0:X}' -f $targetHandle.ToInt64()); dpi=$dpi
   width=$rect.Right-$rect.Left; height=$rect.Bottom-$rect.Top
   requestedWidth=$physicalWidth; requestedHeight=$physicalHeight
   clientWidth=$client.Right-$client.Left; clientHeight=$client.Bottom-$client.Top
   displayWidth=$info.Monitor.Right-$info.Monitor.Left; displayHeight=$info.Monitor.Bottom-$info.Monitor.Top
   workWidth=$info.Work.Right-$info.Work.Left; workHeight=$info.Work.Bottom-$info.Work.Top
   availableWidth=$availableWidth; availableHeight=$availableHeight
  }
  if ($CompatibilityDetails) {
   $thread=[TerminalTestWindow]::GetWindowThreadProcessId($targetHandle,[ref]$owner)
   if (!$thread -or $owner -ne $TargetProcessId) { throw 'Compatibility measurement lost its owned HWND' }
   $measurement.ownsForeground=[TerminalTestWindow]::GetForegroundWindow() -eq $targetHandle
   $measurement.keyboardLanguageId='0x{0:X4}' -f ([TerminalTestWindow]::GetKeyboardLayout($thread).ToInt64() -band 0xFFFF)
   $windows=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
   $measurement.windowsBuild="$($windows.CurrentBuild).$($windows.UBR)"
   $measurement.windowsRelease=$windows.DisplayVersion
   $webview=Get-CimInstance Win32_Process -Filter "ParentProcessId=$TargetProcessId AND Name='msedgewebview2.exe'"
   $measurement.webviewRuntimeVersions=@($webview | ForEach-Object {
    if ($_.ExecutablePath) { (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.ProductVersion }
   } | Sort-Object -Unique)
  }
  if ($Maximize -and !$MeasureOnly) {
   if ([TerminalTestWindow]::MonitorFromWindow($targetHandle,2) -ne $monitor) { throw 'Maximized test window changed monitors' }
   $visible=New-Object TerminalTestWindow+Rect
   if ([TerminalTestWindow]::DwmGetWindowAttribute($targetHandle,9,[ref]$visible,[Runtime.InteropServices.Marshal]::SizeOf($visible)) -ne 0) { throw 'DWM visible bounds query failed' }
   $measurement.Remove('requestedWidth')
   $measurement.Remove('requestedHeight')
   $measurement.maximized=$true
   $measurement.visibleWidth=$visible.Right-$visible.Left
   $measurement.visibleHeight=$visible.Bottom-$visible.Top
   $measurement.visibleMatchesWorkArea=$visible.Left -eq $info.Work.Left -and $visible.Top -eq $info.Work.Top -and $visible.Right -eq $info.Work.Right -and $visible.Bottom -eq $info.Work.Bottom
  }
  $measurement | ConvertTo-Json -Compress
 } finally { [void][TerminalTestWindow]::SetThreadDpiAwarenessContext($previous) }
 return
}
if (-not [TerminalTestWindow]::SetWindowPos($targetHandle,[IntPtr]::Zero,0,0,$Width,$Height,22)) { throw 'Self-test resize failed' }
$targetRect=New-Object TerminalTestWindow+Rect
if (-not [TerminalTestWindow]::GetWindowRect($targetHandle,[ref]$targetRect)) { throw 'Self-test rectangle failed' }
@{width=$targetRect.Right-$targetRect.Left;height=$targetRect.Bottom-$targetRect.Top}|ConvertTo-Json -Compress
