param(
    [Parameter(Mandatory)][int]$TargetProcessId,
    [Parameter(Mandatory)][string]$ExpectedExecutable,
    [string]$Choose
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TestContextMenu {
    delegate bool EnumProc(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags,uint x,uint y,uint data,UIntPtr extra);
    public static IntPtr[] Windows(uint[] owners) {
        var windows = new List<IntPtr>();
        EnumWindows((hwnd, _) => {
            uint id; GetWindowThreadProcessId(hwnd, out id);
            if (IsWindowVisible(hwnd) && Array.IndexOf(owners, id) >= 0) windows.Add(hwnd);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
}
'@
$process = Get-Process -Id $TargetProcessId
if ($process.Path -ne (Resolve-Path -LiteralPath $ExpectedExecutable).ProviderPath) { throw 'Unexpected test window process' }
$owners = [Collections.Generic.HashSet[uint32]]::new()
[void]$owners.Add($TargetProcessId)
$renderers = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'")
do {
    $size=$owners.Count
    foreach($renderer in $renderers) {
        if($owners.Contains($renderer.ParentProcessId)){[void]$owners.Add($renderer.ProcessId)}
    }
} while($owners.Count -ne $size)
[void][TestContextMenu]::SetThreadDpiAwarenessContext([IntPtr](-4))
$walker=[Windows.Automation.TreeWalker]::ControlViewWalker
$scope=[Windows.Automation.TreeScope]::Descendants
$menuItems=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::MenuItem)
$observed=[Collections.Generic.List[object]]::new()
$eligible=[Collections.Generic.List[object]]::new()
foreach($handle in [TestContextMenu]::Windows([uint32[]]@($owners))){
    $root=[Windows.Automation.AutomationElement]::FromHandle($handle)
    if(!$root){continue}
    foreach($item in $root.FindAll($scope,$menuItems)){
        if($item.Current.IsOffscreen){continue}
        $ancestor=$walker.GetParent($item)
        $document=$false
        while($ancestor){
            if($ancestor.Current.ControlType -eq [Windows.Automation.ControlType]::Document){$document=$true;break}
            $ancestor=$walker.GetParent($ancestor)
        }
        if($document){continue}
        $observed.Add([ordered]@{name=$item.Current.Name;enabled=$item.Current.IsEnabled})
        if($Choose -and $item.Current.Name -ceq $Choose -and $item.Current.IsEnabled){$eligible.Add($item)}
    }
}
if($Choose){
    if($eligible.Count -ne 1){throw "Expected one enabled item in the owned native menu"}
    $chosen=$eligible[0]
    $pattern=$null
    if($chosen.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
        $pattern.Invoke()
    }else{
        $point=$chosen.GetClickablePoint()
        $under=[Windows.Automation.AutomationElement]::FromPoint($point)
        if(![Windows.Automation.Automation]::Compare($under,$chosen)){throw 'Native menu hit test changed'}
        [uint32]$foregroundOwner=0
        [void][TestContextMenu]::GetWindowThreadProcessId([TestContextMenu]::GetForegroundWindow(),[ref]$foregroundOwner)
        if(!$owners.Contains($foregroundOwner) -or ![TestContextMenu]::SetCursorPos($point.X,$point.Y)){throw 'Native menu lost ownership'}
        [TestContextMenu]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
        [TestContextMenu]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
    }
}
[ordered]@{items=@($observed);chose=[bool]$Choose}|ConvertTo-Json -Depth 4 -Compress
