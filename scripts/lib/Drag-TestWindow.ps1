param(
    [Parameter(Mandatory=$true)][int]$TargetProcessId,
    [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
    [Parameter(Mandatory=$true)][string]$Points,
    [string]$Title,
    [switch]$Raise,
    [string]$LandingTitle
)
$ErrorActionPreference = 'Stop'
$target = Get-Process -Id $TargetProcessId
if ($target.Path -ne (Resolve-Path -LiteralPath $ExpectedExecutable).ProviderPath) { throw 'Unexpected test window executable' }

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class TerminalTestMouse {
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point point);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(Point point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")] public static extern int GetWindowLongW(IntPtr h,int index);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h,int command);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 delegate bool WindowCallback(IntPtr h, IntPtr state);
 [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr state);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int length);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 public static IntPtr FindWindow(uint process,string title) {
   IntPtr found=IntPtr.Zero;
   EnumWindows((h,state)=>{
     uint owner;
     GetWindowThreadProcessId(h,out owner);
     if(owner!=process || !IsWindowVisible(h)) return true;
     var text=new StringBuilder(256);
     GetWindowText(h,text,text.Capacity);
     if(text.ToString()!=title) return true;
     found=h;
     return false;
   },IntPtr.Zero);
   return found;
 }
}
"@

$window = if ($Title) { [TerminalTestMouse]::FindWindow($TargetProcessId,$Title) } else { $target.MainWindowHandle }
[uint32]$owner = 0
if (![TerminalTestMouse]::GetWindowThreadProcessId($window,[ref]$owner) -or $owner -ne $TargetProcessId) { throw 'Test window owner changed' }
$previousDpi = [TerminalTestMouse]::SetThreadDpiAwarenessContext([IntPtr](-4))
if (!$previousDpi) { throw 'Unable to measure physical screen coordinates' }
$original = New-Object TerminalTestMouse+Point
[void][TerminalTestMouse]::GetCursorPos([ref]$original)
$pressed = $false
$raised = $false
$raisedLanding = $false
$landing = [IntPtr]::Zero
try {
    if ($LandingTitle) {
        $landing = [TerminalTestMouse]::FindWindow($TargetProcessId,$LandingTitle)
        [uint32]$landingOwner = 0
        if (!$landing -or $landing -eq $window -or ![TerminalTestMouse]::GetWindowThreadProcessId($landing,[ref]$landingOwner) -or $landingOwner -ne $TargetProcessId) {
            throw 'Unexpected test landing window'
        }
        $raisedLanding = -not ([TerminalTestMouse]::GetWindowLongW($landing,-20) -band 8)
        if (![TerminalTestMouse]::SetWindowPos($landing,[IntPtr](-1),0,0,0,0,19)) { throw 'Unable to raise the verified landing window' }
    }
    if ($Raise) {
        $raised = -not ([TerminalTestMouse]::GetWindowLongW($window,-20) -band 8)
        [void][TerminalTestMouse]::ShowWindow($window,5)
        if (![TerminalTestMouse]::SetWindowPos($window,[IntPtr](-1),0,0,0,0,67)) { throw 'Unable to raise the verified test window' }
        [void][TerminalTestMouse]::SetForegroundWindow($window)
        Start-Sleep -Milliseconds 150
    }
    $scale = [TerminalTestMouse]::GetDpiForWindow($window) / 96
    $steps = @($Points | ConvertFrom-Json)
    for ($i=0; $i -lt $steps.Count; $i++) {
        $point = New-Object TerminalTestMouse+Point
        if ($steps[$i].landings) {
            if (!$landing -or $i -ne $steps.Count-1) { throw 'Landing points require an owned destination and final step' }
            $landingScale = [TerminalTestMouse]::GetDpiForWindow($landing) / 96
            $destinationFound = $false
            foreach ($candidate in $steps[$i].landings) {
                $point.X = [int][Math]::Round($candidate.x * $landingScale)
                $point.Y = [int][Math]::Round($candidate.y * $landingScale)
                if ([TerminalTestMouse]::ClientToScreen($landing,[ref]$point) -and
                    [TerminalTestMouse]::GetAncestor([TerminalTestMouse]::WindowFromPoint($point),2) -eq $landing) {
                    $destinationFound = $true
                    break
                }
            }
            if (!$destinationFound) { throw 'No unobstructed point on the verified landing window' }
        } else {
            $point.X = [int][Math]::Round($steps[$i].x * $scale)
            $point.Y = [int][Math]::Round($steps[$i].y * $scale)
            if (![TerminalTestMouse]::ClientToScreen($window,[ref]$point)) { throw 'Window coordinates unavailable' }
        }
        $hit = [TerminalTestMouse]::GetAncestor([TerminalTestMouse]::WindowFromPoint($point),2)
        if ($i -eq 0 -and $hit -ne $window) {
            [uint32]$hitOwner = 0
            if ($hit) { [void][TerminalTestMouse]::GetWindowThreadProcessId($hit,[ref]$hitOwner) }
            $rootOwner = [TerminalTestMouse]::GetAncestor($hit,3)
            $webView = if ($Raise -and $hitOwner) { Get-CimInstance Win32_Process -Filter "ProcessId=$hitOwner" }
            if ($rootOwner -ne $window -and !($webView.Name -eq 'msedgewebview2.exe' -and $webView.ParentProcessId -eq $TargetProcessId)) {
                $foreground = [TerminalTestMouse]::GetForegroundWindow() -eq $window
                throw "The owned test window is not under the starting point ($($steps[$i].x), $($steps[$i].y)); hit $($webView.Name) PID $hitOwner parent $($webView.ParentProcessId); expected $TargetProcessId; foreground $foreground"
            }
        }
        if ($i -eq $steps.Count-1 -and $steps[$i].outside -and $hit -eq $window) { throw 'The ending point is inside the owned test window' }
        if (![TerminalTestMouse]::SetCursorPos($point.X,$point.Y)) { throw 'Cursor positioning failed' }
        Start-Sleep -Milliseconds 100
        if ($steps[$i].holdMs -gt 0) { Start-Sleep -Milliseconds ([int]$steps[$i].holdMs) }
        if ($i -eq 0) {
            [TerminalTestMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
            $pressed = $true
            Start-Sleep -Milliseconds 100
        }
    }
} finally {
    if ($pressed) { [TerminalTestMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 200
    if ($raised) { [void][TerminalTestMouse]::SetWindowPos($window,[IntPtr](-2),0,0,0,0,19) }
    if ($raisedLanding) { [void][TerminalTestMouse]::SetWindowPos($landing,[IntPtr](-2),0,0,0,0,19) }
    [void][TerminalTestMouse]::SetCursorPos($original.X,$original.Y)
    [void][TerminalTestMouse]::SetThreadDpiAwarenessContext($previousDpi)
}
