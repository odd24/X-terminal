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
$id=[Windows.Automation.AutomationElement]::AutomationIdProperty
function Find-FileNameEditor($picker) {
    $hostControl=$picker.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new($id,'FileNameControlHost'))
    if($hostControl) {
        $editor=$hostControl.FindFirst([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit))
        if($editor) { return $editor }
    }
    $editors=$picker.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new($id,'1001'))
    foreach($candidate in $editors) {
        if($candidate.Current.ControlType -eq [Windows.Automation.ControlType]::Edit -and $candidate.Current.Name -match '文件名|File name') { return $candidate }
    }
    return $null
}
function Find-PickerButton($picker) {
    $buttons=$picker.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
    foreach($candidate in $buttons) {
        $pickerButtonMatches=if($Action -eq 'select') { $candidate.Current.Name -eq '选择保存位置' } else { $candidate.Current.Name -match '^(取消|Cancel)' }
        $invokePattern=$null
        if($pickerButtonMatches -and $candidate.Current.IsEnabled -and $candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invokePattern)) { return $candidate }
    }
    return $null
}
$edit=$null;$button=$null;$controlWaits=0
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
    if($dialog) {
        $edit=if($Action -eq 'select') { Find-FileNameEditor $dialog } else { $null }
        $button=Find-PickerButton $dialog
        # A titled window/editor can precede the requested button. Cancellation
        # needs the same readiness check; do not act on another process or label.
        if(!$button -or ($Action -eq 'select' -and !$edit)) {
            $controlWaits++
            if($controlWaits -eq 1) { Write-Output "WAIT native picker controls action=$Action editor=$([bool]$edit) button=$([bool]$button)" }
            $dialog=$null
        }
    }
    if($dialog) { break }; Start-Sleep -Milliseconds 100
}
if(!$dialog) { throw "The native save picker controls were not ready in the test process: action=$Action attempts=$attempt controlWaits=$controlWaits" }
Write-Output "READY native picker action=$Action attempts=$attempt controlWaits=$controlWaits"
if($Action -eq 'select') {
    if(!$edit) { throw 'Native file-name editor 1001 not found.' }
    $pattern=$edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue($resolved)
}
if(!$button) { throw 'Native picker button was not found.' }
$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output "PASS native save picker $Action"
