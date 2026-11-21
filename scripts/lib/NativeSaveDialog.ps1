param([Parameter(Mandatory)][int]$TargetProcessId, [ValidateSet('select','cancel','explorer','program','program-cancel')][string]$Action, [string]$TargetPath)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$program = $Action -in @('program','program-cancel')
$select = $Action -in @('select','program')
if ($Action -eq 'explorer' -or $select) {
    $resolved=[IO.Path]::GetFullPath($TargetPath)
    $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    $rootName=[IO.Path]::GetRelativePath($temporary,$resolved).Split([IO.Path]::DirectorySeparatorChar)[0]
    $prefix=if($program){'shared-terminal-log-viewer-ui-中文-'}else{'shared-terminal-save-ui-中文-'}
    if (!$resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or !$rootName.StartsWith($prefix) -or ($program -and [IO.Path]::GetExtension($resolved) -ne '.exe')) { throw 'Only the isolated test target is allowed.' }
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
        $pickerButtonMatches=if($Action -eq 'program') { $candidate.Current.Name -match '^(打开|Open)' } elseif($select) { $candidate.Current.Name -eq '保存' } else { $candidate.Current.Name -match '^(取消|Cancel)' }
        $invokePattern=$null
        if($pickerButtonMatches -and $candidate.Current.IsEnabled -and $candidate.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invokePattern)) { return $candidate }
    }
    return $null
}
$edit=$null;$button=$null;$controlWaits=0;$lastPicker=$null
for($attempt=0;$attempt -lt 100;$attempt++) {
    $candidates=[Collections.Generic.List[IntPtr]]::new()
    $callback=[NativeSaveTestWindow+Callback]{ param($window,$unused)
        [uint32]$windowProcess=0
        [void][NativeSaveTestWindow]::GetWindowThreadProcessId($window,[ref]$windowProcess)
        if($windowProcess -eq $TargetProcessId) {
            $caption=[Text.StringBuilder]::new(1024);[void][NativeSaveTestWindow]::GetWindowText($window,$caption,1024)
            $title=$caption.ToString()
            if(($program -and $title -eq '选择日志打开程序') -or (!$program -and ($title.StartsWith('另存终端导出') -or $title -eq '保存文本日志'))) { $candidates.Add($window) }
        }
        return $true
    }
    [void][NativeSaveTestWindow]::EnumWindows($callback,[IntPtr]::Zero)
    if($candidates.Count) { $handle=$candidates[0];[void][NativeSaveTestWindow]::ShowWindow($handle,9);$dialog=[Windows.Automation.AutomationElement]::FromHandle($handle);$lastPicker=$dialog }
    if($dialog) {
        $edit=if($select) { Find-FileNameEditor $dialog } else { $null }
        $button=Find-PickerButton $dialog
        # A titled window/editor can precede the requested button. Cancellation
        # needs the same readiness check; do not act on another process or label.
        if(!$button -or ($select -and !$edit)) {
            $controlWaits++
            if($controlWaits -eq 1) { Write-Output "WAIT native picker controls action=$Action editor=$([bool]$edit) button=$([bool]$button)" }
            $dialog=$null
        }
    }
    if($dialog) { break }; Start-Sleep -Milliseconds 100
}
if(!$dialog) {
    if($lastPicker) {
        # Diagnostics are bounded to the exact owned test picker, never the desktop tree.
        $nodes=$lastPicker.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        Write-Output "PICKER diagnostic target=$TargetProcessId children=$($nodes.Count) rootType=$($lastPicker.Current.ControlType.ProgrammaticName) rootProcess=$($lastPicker.Current.ProcessId)"
        for($i=0;$i -lt [Math]::Min(30,$nodes.Count);$i++) { $node=$nodes[$i].Current;Write-Output "CONTROL type=$($node.ControlType.ProgrammaticName) id=$($node.AutomationId) name=$($node.Name) enabled=$($node.IsEnabled) offscreen=$($node.IsOffscreen)" }
    }
    throw "The native save picker controls were not ready in the test process: action=$Action attempts=$attempt controlWaits=$controlWaits"
}
Write-Output "READY native picker action=$Action attempts=$attempt controlWaits=$controlWaits"
if($select) {
    if(!$edit) { throw 'Native file-name editor 1001 not found.' }
    $pattern=$edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
    $pattern.SetValue($resolved)
}
if(!$button) { throw 'Native picker button was not found.' }
$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern).Invoke()
Write-Output "PASS native save picker $Action"
