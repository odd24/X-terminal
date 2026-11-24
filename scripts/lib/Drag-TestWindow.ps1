param(
    [Parameter(Mandatory=$true)][int]$TargetProcessId,
    [Parameter(Mandatory=$true)][string]$ExpectedExecutable,
    [Parameter(Mandatory=$true)][string]$Points,
    [string]$Title,
    [switch]$Raise,
    [switch]$PlaceAtWorkAreaStart,
    [switch]$MeasureMovement,
    [switch]$HoldOutside,
    [switch]$AtomicDrag,
    [ValidateSet('Left','Right','DoubleLeft')][string]$Click,
    [string]$LandingTitle,
    [ValidateSet('CtrlTab','CtrlShiftTab','CtrlShiftT','CtrlShiftB','CtrlShiftF','Alt1','Alt0','AltNumpad1')][string]$KeyboardChord
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
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor,Work; public uint Flags; }
 [StructLayout(LayoutKind.Sequential)] struct MouseInput {
   public int X,Y; public uint Data,Flags,Time; public UIntPtr ExtraInfo;
 }
 [StructLayout(LayoutKind.Sequential)] struct Input { public uint Type; public MouseInput Mouse; }
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h,ref Point point);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect rect);
 [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
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
 [DllImport("user32.dll")] static extern int GetSystemMetrics(int metric);
 [DllImport("user32.dll")] static extern uint SendInput(uint count, Input[] inputs, int size);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
 [DllImport("user32.dll")] public static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static bool SendOwnedGesture(Point[] points, IntPtr expectedRoot, bool doubleClick) {
   int left=GetSystemMetrics(76), top=GetSystemMetrics(77);
   int width=GetSystemMetrics(78), height=GetSystemMetrics(79);
   if (width<2 || height<2) return false;
   var events=new Input[doubleClick ? 5 : points.Length+2];
   for (int i=0; i<points.Length; i++) {
     var point=points[i];
     if (point.X<left || point.X>=left+width || point.Y<top || point.Y>=top+height ||
         GetAncestor(WindowFromPoint(point),2)!=expectedRoot) return false;
     events[i==0 ? 0 : i+1].Mouse=new MouseInput {
       X=(int)Math.Ceiling((point.X-left)*65536.0/width),
       Y=(int)Math.Ceiling((point.Y-top)*65536.0/height),
       Flags=0xe001
     };
   }
   events[1].Mouse.Flags=2;
   if (doubleClick) {
     events[2].Mouse.Flags=4;
     events[3].Mouse.Flags=2;
   }
   events[events.Length-1].Mouse.Flags=4;
   return SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(Input)))==events.Length;
 }
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
    if ($PlaceAtWorkAreaStart) {
        $area = New-Object TerminalTestMouse+MonitorInfo
        $area.Size = [Runtime.InteropServices.Marshal]::SizeOf($area)
        $rect = New-Object TerminalTestMouse+Rect
        $monitor = [TerminalTestMouse]::MonitorFromWindow($window,2)
        if (![TerminalTestMouse]::GetMonitorInfo($monitor,[ref]$area) -or ![TerminalTestMouse]::GetWindowRect($window,[ref]$rect)) {
            throw 'The owned test window work area is unavailable'
        }
        $x = $area.Work.Left + 64
        $y = $area.Work.Top + 32
        if ($x+$rect.Right-$rect.Left -gt $area.Work.Right -or $y+$rect.Bottom-$rect.Top -gt $area.Work.Bottom) {
            throw 'The owned test window would not fit at the work area start'
        }
        if (![TerminalTestMouse]::SetWindowPos($window,[IntPtr]::Zero,$x,$y,0,0,21)) { throw 'Unable to place the owned test window' }
    }
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
    if ($KeyboardChord) {
        if ($Click -or $HoldOutside -or $LandingTitle -or @($Points | ConvertFrom-Json).Count -ne 0) { throw 'Keyboard mode needs no pointer points' }
        if ([TerminalTestMouse]::GetForegroundWindow() -ne $window) { throw 'The verified test window must own keyboard focus' }
        $chords = @{
            CtrlTab=@(0x11,0x09); CtrlShiftTab=@(0x11,0x10,0x09)
            CtrlShiftT=@(0x11,0x10,0x54); CtrlShiftB=@(0x11,0x10,0x42); CtrlShiftF=@(0x11,0x10,0x46)
            Alt1=@(0x12,0x31); Alt0=@(0x12,0x30); AltNumpad1=@(0x12,0x61)
        }
        $down=[Collections.Generic.List[byte]]::new()
        try {
            foreach($key in $chords[$KeyboardChord]){
                if ([TerminalTestMouse]::GetForegroundWindow() -ne $window) { throw 'Keyboard focus left the verified test window' }
                [TerminalTestMouse]::keybd_event($key,0,0,[UIntPtr]::Zero)
                $down.Add($key)
            }
        } finally {
            for($i=$down.Count-1;$i -ge 0;$i--){[TerminalTestMouse]::keybd_event($down[$i],0,2,[UIntPtr]::Zero)}
        }
        return
    }
    $scale = [TerminalTestMouse]::GetDpiForWindow($window) / 96
    $steps = @($Points | ConvertFrom-Json)
    if ($HoldOutside) {
        if ($steps.Count -ne 1 -or !$steps[0].outside -or $Click -or $MeasureMovement) {
            throw 'The cursor hold requires one outside point and no mouse clicks'
        }
        $point = New-Object TerminalTestMouse+Point
        $point.X = [int][Math]::Round($steps[0].x * $scale)
        $point.Y = [int][Math]::Round($steps[0].y * $scale)
        $rect = New-Object TerminalTestMouse+Rect
        if (![TerminalTestMouse]::ClientToScreen($window,[ref]$point) -or ![TerminalTestMouse]::GetWindowRect($window,[ref]$rect)) {
            throw 'Could not locate the owned window and cursor point'
        }
        if ($point.X -ge $rect.Left -and $point.X -lt $rect.Right -and $point.Y -ge $rect.Top -and $point.Y -lt $rect.Bottom) {
            throw 'The cursor hold point is inside the owned test window'
        }
        if (![TerminalTestMouse]::SetCursorPos($point.X,$point.Y)) { throw 'Cursor positioning failed' }
        Write-Output 'OWNED_POINTER_OUTSIDE'
        Start-Sleep -Seconds 3
        return
    }
    if ($Click -and ($steps.Count -ne 1 -or $steps[0].outside -or $steps[0].landings)) { throw 'A click requires one owned client point' }
    if ($AtomicDrag -and ($Click -or $HoldOutside -or $MeasureMovement -or $LandingTitle -or $steps.Count -lt 2 -or
        ($steps | Where-Object { $_.outside -or $_.landings -or $_.holdMs }))) { throw 'Atomic drag requires only points in one owned window' }
    if ($PlaceAtWorkAreaStart -and $Raise -and ($AtomicDrag -or $Click -eq 'DoubleLeft')) {
        function Test-OwnedClientPoints {
            foreach ($step in $steps) {
                $probe = New-Object TerminalTestMouse+Point
                $probe.X = [int][Math]::Round($step.x * $scale)
                $probe.Y = [int][Math]::Round($step.y * $scale)
                if (![TerminalTestMouse]::ClientToScreen($window,[ref]$probe) -or
                    [TerminalTestMouse]::GetAncestor([TerminalTestMouse]::WindowFromPoint($probe),2) -ne $window) {
                    return $false
                }
            }
            return $true
        }
        $ownedPoints = Test-OwnedClientPoints
        if (!$ownedPoints) {
            $width = $rect.Right - $rect.Left
            $height = $rect.Bottom - $rect.Top
            $positions = @(
                @{left=$area.Work.Right - $width - 32;top=$area.Work.Top + 32},
                @{left=$area.Work.Left + 32;top=$area.Work.Bottom - $height - 32},
                @{left=$area.Work.Right - $width - 32;top=$area.Work.Bottom - $height - 32}
            )
            foreach ($position in $positions) {
                $left = $position.left
                $top = $position.top
                if ($left -lt $area.Work.Left -or $top -lt $area.Work.Top -or
                    $left+$width -gt $area.Work.Right -or $top+$height -gt $area.Work.Bottom) { continue }
                if (![TerminalTestMouse]::SetWindowPos($window,[IntPtr](-1),$left,$top,0,0,65)) {
                    throw 'Unable to reposition the owned test window'
                }
                Start-Sleep -Milliseconds 120
                if (Test-OwnedClientPoints) { $ownedPoints=$true; break }
            }
        }
        if (!$ownedPoints) { throw 'No unobstructed placement for the owned mouse gesture' }
    }
    $atomicPoints=[Collections.Generic.List[TerminalTestMouse+Point]]::new()
    if ($MeasureMovement) {
        if ($Click) { throw 'Movement measurements require a drag.' }
        $dragStart = New-Object TerminalTestMouse+Rect
        if (![TerminalTestMouse]::GetWindowRect($window,[ref]$dragStart)) { throw 'Could not measure the owned window before the drag.' }
    }
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
        if ($AtomicDrag -or $Click -eq 'DoubleLeft') {
            if ($i -eq 0) { $atomicRoot=$hit }
            $atomicPoints.Add($point)
            continue
        }
        if (![TerminalTestMouse]::SetCursorPos($point.X,$point.Y)) { throw 'Cursor positioning failed' }
        Start-Sleep -Milliseconds 100
        if ($steps[$i].holdMs -gt 0) { Start-Sleep -Milliseconds ([int]$steps[$i].holdMs) }
        if ($i -eq 0) {
            if ($Click) {
                $down,$up=if($Click -eq 'Right'){8,16}else{2,4}
                [TerminalTestMouse]::mouse_event($down,0,0,0,[UIntPtr]::Zero)
                [TerminalTestMouse]::mouse_event($up,0,0,0,[UIntPtr]::Zero)
                continue
            }
            [TerminalTestMouse]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
            $pressed = $true
            Start-Sleep -Milliseconds 100
        }
    }
    if ($atomicPoints.Count -and ![TerminalTestMouse]::SendOwnedGesture($atomicPoints.ToArray(),$atomicRoot,($Click -eq 'DoubleLeft'))) {
        throw 'Unable to send the mouse gesture to the owned window'
    }
} finally {
    if ($pressed) { [TerminalTestMouse]::mouse_event(4,0,0,0,[UIntPtr]::Zero) }
    Start-Sleep -Milliseconds 200
    if ($MeasureMovement -and $dragStart) {
        $dragEnd = New-Object TerminalTestMouse+Rect
        if ([TerminalTestMouse]::GetWindowRect($window,[ref]$dragEnd)) {
            @{dx=$dragEnd.Left-$dragStart.Left;dy=$dragEnd.Top-$dragStart.Top} | ConvertTo-Json -Compress
        }
    }
    if ($raised) { [void][TerminalTestMouse]::SetWindowPos($window,[IntPtr](-2),0,0,0,0,19) }
    if ($raisedLanding) { [void][TerminalTestMouse]::SetWindowPos($landing,[IntPtr](-2),0,0,0,0,19) }
    [void][TerminalTestMouse]::SetCursorPos($original.X,$original.Y)
    [void][TerminalTestMouse]::SetThreadDpiAwarenessContext($previousDpi)
}
