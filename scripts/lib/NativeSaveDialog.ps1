param([Parameter(Mandatory)][int]$TargetProcessId, [ValidateSet('select','cancel','explorer')][string]$Action, [string]$TargetPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
if ($Action -eq 'explorer' -or $Action -eq 'select') {
    $resolved=[IO.Path]::GetFullPath($TargetPath)
    $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (!$resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or !([IO.Path]::GetRelativePath($temporary,$resolved).Split([IO.Path]::DirectorySeparatorChar)[0].StartsWith('shared-terminal-save-ui-中文-'))) { throw 'Only the isolated save-test temporary root is allowed.' }
}
if ($Action -eq 'explorer') {
    $shell=New-Object -ComObject Shell.Application
    for($attempt=0;$attempt -lt 100;$attempt++) {
        foreach($window in @($shell.Windows())) { try { if ([string]$window.Document.Folder.Self.Path -eq $resolved) { $window.Quit(); Write-Output 'PASS explorer opened the isolated selected folder'; exit 0 } } catch {} }
        Start-Sleep -Milliseconds 100
    }
    throw 'The selected test folder was not observed in Explorer.'
}
$root=[Windows.Automation.AutomationElement]::RootElement
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeSaveTestWindow {
 public delegate bool Callback(IntPtr window, IntPtr state);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
}
'@
$dialog=$null
for($attempt=0;$attempt -lt 100;$attempt++) {
    $candidates=[Collections.Generic.List[IntPtr]]::new()
    $callback=[NativeSaveTestWindow+Callback]{ param($window,$unused)
        [uint32]$windowProcess=0
        [void][NativeSaveTestWindow]::GetWindowThreadProcessId($window,[ref]$windowProcess)
        if($windowProcess -eq $TargetProcessId) {
            $caption=[Text.StringBuilder]::new(1024);[void][NativeSaveTestWindow]::GetWindowText($window,$caption,1024)
            if($caption.ToString().StartsWith('另存终端导出')) { $candidates.Add($window) }
        }
        return $true
    }
    [void][NativeSaveTestWindow]::EnumWindows($callback,[IntPtr]::Zero)
    if($candidates.Count) { $handle=$candidates[0];[void][NativeSaveTestWindow]::ShowWindow($handle,9);$dialog=[Windows.Automation.AutomationElement]::FromHandle($handle) }
    if($dialog) { break }; Start-Sleep -Milliseconds 100
}
if(!$dialog) { throw 'The native save picker was not found in the test process.' }
$id=[Windows.Automation.AutomationElement]::AutomationIdProperty
if($Action -eq 'select') {
    $edit=$null
    $hostControl=$dialog.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new($id,'FileNameControlHost'))
    if($hostControl) { $edit=$hostControl.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)) }
    if(!$edit) {
        $editors=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new($id,'1001'))
        foreach($candidate in $editors) { if($candidate.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and $candidate.Current.Name -match '文件名|File name') { $edit=$candidate; break } }
    }
    if(!$edit) { throw 'Native file-name editor 1001 not found.' }
    $pattern=$edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue($resolved)
    $buttons=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
    $button=$null;foreach($candidate in $buttons) { if($candidate.Current.Name -eq '选择保存位置') { $button=$candidate;break } }
} else {
    $buttons=$dialog.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
    $button=$null;foreach($candidate in $buttons) { if($candidate.Current.Name -match '^(取消|Cancel)') { $button=$candidate;break } }
}
if(!$button) { throw 'Native picker button was not found.' }
$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output "PASS native save picker $Action"
