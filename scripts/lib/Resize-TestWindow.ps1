param([Parameter(Mandatory=$true)][int]$TargetProcessId,[Parameter(Mandatory=$true)][ValidateRange(640,2000)][int]$Width,[Parameter(Mandatory=$true)][ValidateRange(480,1400)][int]$Height)
$ErrorActionPreference='Stop'
$targetProcess=Get-Process -Id $TargetProcessId
if ([System.IO.Path]::GetFileName($targetProcess.Path) -ne 'shared-terminal-desktop.exe') { throw 'Unexpected test window process' }
$targetHandle=$targetProcess.MainWindowHandle
if ($targetHandle -eq [IntPtr]::Zero) { throw 'No self-test main window' }
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class TerminalTestWindow {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int w,int hgt,uint flags);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool GetWindowRect(IntPtr h,out Rect r);
}
"@
if (-not [TerminalTestWindow]::SetWindowPos($targetHandle,[IntPtr]::Zero,0,0,$Width,$Height,22)) { throw 'Self-test resize failed' }
$targetRect=New-Object TerminalTestWindow+Rect
if (-not [TerminalTestWindow]::GetWindowRect($targetHandle,[ref]$targetRect)) { throw 'Self-test rectangle failed' }
@{width=$targetRect.Right-$targetRect.Left;height=$targetRect.Bottom-$targetRect.Top}|ConvertTo-Json -Compress
