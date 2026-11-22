param([Parameter(Mandatory)][int]$TargetProcessId, [Parameter(Mandatory)][string]$Root, [ValidateSet('select','cancel')][string]$Action, [string]$TargetPath, [ValidateSet('Import','ProtectedExport','SaveRecovery','LogViewer','TextLog','LocalScripts','LocalDirectory')][string]$Purpose='Import', [string]$TargetsBase64)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$testRoot=[IO.Path]::GetFullPath($Root)
$save=$Purpose -in @('ProtectedExport','SaveRecovery','TextLog')
$nativeEditorFallback=$Purpose -ne 'Import'
$rootPrefix=switch($Purpose){'ProtectedExport'{'shared-terminal-save-ui-中文-protected-'} 'SaveRecovery'{'shared-terminal-save-ui-中文-recovery-'} 'LogViewer'{'shared-terminal-log-viewer-ui-中文-'} 'TextLog'{'shared-terminal-save-ui-中文-'} 'LocalScripts'{'shared-terminal-local-scripts-中文-'} 'LocalDirectory'{'shared-terminal-local-directory-中文-'} default{'shared-terminal-import-config-ui-中文-'}}
$pickerTitle=switch($Purpose){'ProtectedExport'{'另存受保护文本'} 'SaveRecovery'{'另存终端导出'} 'LogViewer'{'选择日志打开程序'} 'TextLog'{'保存文本日志'} 'LocalScripts'{'选择本地脚本'} 'LocalDirectory'{'选择本地终端默认目录'} default{'选择原生连接配置 JSON'}}
if (![IO.Path]::GetFileName($testRoot).StartsWith($rootPrefix) -or ($nativeEditorFallback -and [IO.Path]::GetDirectoryName($testRoot) -ne [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar))) { throw 'Only the explicitly owned test root is allowed.' }
if ($Action -eq 'select') {
 $targets=@($TargetPath)
 if ($Purpose -eq 'LocalScripts' -and $TargetsBase64) {
   $targets=@([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($TargetsBase64)) | ConvertFrom-Json)
 }
 $paths = @(foreach($target in $targets) {
   $checked=[IO.Path]::GetFullPath($target)
   if (!$checked.StartsWith($testRoot+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Only a target under the exact owned test root is allowed.' }
   $exists=if($Purpose -eq 'LocalDirectory'){[IO.Directory]::Exists($checked)}else{[IO.File]::Exists($checked)}
   if ((!$save -and !$exists) -or ($Purpose -eq 'LogViewer' -and [IO.Path]::GetExtension($checked) -ne '.exe') -or ($Purpose -eq 'LocalScripts' -and [IO.Path]::GetExtension($checked) -notin @('.bat','.cmd'))) { throw 'Only a target under the exact owned test root is allowed.' }
   $checked
 })
 $resolved=if($paths.Count -eq 1){$paths[0]}else{($paths | ForEach-Object {'"'+$_+'"'}) -join ' '}
}
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class NativeImportTestWindow {
 public delegate bool Callback(IntPtr window, IntPtr state);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr window, StringBuilder text, int capacity);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetDlgItem(IntPtr window, int id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int capacity);
 [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr window);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool PostMessageW(IntPtr window,uint message,IntPtr wp,IntPtr lp);
 [DllImport("user32.dll",CharSet=CharSet.Unicode,EntryPoint="SendMessageW")] public static extern IntPtr SetText(IntPtr window,uint message,IntPtr wp,string text);
 [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr window,Callback callback,IntPtr state);
 [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);


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
function Get-NativeClass($handle) { $text=[Text.StringBuilder]::new(128);[void][NativeImportTestWindow]::GetClassName($handle,$text,128); return $text.ToString() }
function Find-PickerButton($handle) {
    if ((Get-NativeClass $handle) -ne '#32770') { return [IntPtr]::Zero }
    $controlId=if($Action -eq 'select'){1}else{2}
    $candidate=[NativeImportTestWindow]::GetDlgItem($handle,$controlId)
    if ((Get-NativeClass $candidate) -ne 'Button' -or ![NativeImportTestWindow]::IsWindowEnabled($candidate)) { return [IntPtr]::Zero }
    $label=[Text.StringBuilder]::new(128);[void][NativeImportTestWindow]::GetWindowText($candidate,$label,128)
    $normal=$label.ToString().Replace('&','')
    $matches=if($Action -eq 'cancel'){$normal -match '^(取消|Cancel)'}elseif($save){$normal -eq '保存'}elseif($Purpose -eq 'LocalDirectory'){$normal -eq '选择文件夹'}else{$normal -match '^(打开|Open)(\([Oo]\))?$'}
    if (!$matches) { return [IntPtr]::Zero }; return $candidate
}
function Find-NativeFileEditor($handle) {
    if($Purpose -eq 'LocalDirectory') {
        $folderEditor=[NativeImportTestWindow]::GetDlgItem($handle,1152)
        if ((Get-NativeClass $folderEditor) -eq 'Edit') { return $folderEditor }
        return [IntPtr]::Zero
    }
    $container=[NativeImportTestWindow]::GetDlgItem($handle,1148)
    if ((Get-NativeClass $container) -eq 'Edit') { return $container }
    if ((Get-NativeClass $container) -notmatch '^ComboBox') {
        if (!$nativeEditorFallback) { return [IntPtr]::Zero }
        $containers=[Collections.Generic.List[IntPtr]]::new()
        $knownEditors=[Collections.Generic.List[IntPtr]]::new()
        $findKnown=[NativeImportTestWindow+Callback]{param($child,$unused)
            $control=[NativeImportTestWindow]::GetDlgCtrlID($child)
            $class=Get-NativeClass $child
            if($control -eq 1148 -and $class -match '^ComboBox'){$containers.Add($child)}
            if($control -in @(1001,1148) -and $class -eq 'Edit'){$knownEditors.Add($child)}
            return $true
        }
        [void][NativeImportTestWindow]::EnumChildWindows($handle,$findKnown,[IntPtr]::Zero)
        if($knownEditors.Count -eq 1){return $knownEditors[0]}
        if($containers.Count -ne 1){return [IntPtr]::Zero}
        $container=$containers[0]
    }
    $editors=[Collections.Generic.List[IntPtr]]::new()
    $callback=[NativeImportTestWindow+Callback]{param($child,$unused)
        if((Get-NativeClass $child) -eq 'Edit'){$editors.Add($child)};return $true
    }
    [void][NativeImportTestWindow]::EnumChildWindows($container,$callback,[IntPtr]::Zero)
    if($editors.Count -eq 1){return $editors[0]};return [IntPtr]::Zero
}
$edit=$null;$button=[IntPtr]::Zero;$nativeEdit=[IntPtr]::Zero;$controlWaits=0;$lastPicker=$null
for($attempt=0;$attempt -lt 100;$attempt++) {
    $candidates=[Collections.Generic.List[IntPtr]]::new()
    $callback=[NativeImportTestWindow+Callback]{ param($window,$unused)
        [uint32]$windowProcess=0
        [void][NativeImportTestWindow]::GetWindowThreadProcessId($window,[ref]$windowProcess)
        if($windowProcess -eq $TargetProcessId) {
            $caption=[Text.StringBuilder]::new(1024);[void][NativeImportTestWindow]::GetWindowText($window,$caption,1024)
            if($caption.ToString() -eq $pickerTitle) { $candidates.Add($window) }
        }
        return $true
    }
    [void][NativeImportTestWindow]::EnumWindows($callback,[IntPtr]::Zero)
    if($candidates.Count) { $handle=$candidates[0];[void][NativeImportTestWindow]::ShowWindow($handle,9);$dialog=[Windows.Automation.AutomationElement]::FromHandle($handle);$lastPicker=$dialog }
    if($dialog) {
        $nativeEdit=if($Action -eq 'select'){Find-NativeFileEditor $handle}else{[IntPtr]::Zero}
        $edit=if($Action -eq 'select' -and $nativeEdit -eq [IntPtr]::Zero) { Find-FileNameEditor $dialog } else { $null }
        $button=Find-PickerButton $handle
        # A titled window/editor can precede the requested button. Cancellation
        # needs the same readiness check; do not act on another process or label.
        if(!$button -or ($Action -eq 'select' -and !$edit -and $nativeEdit -eq [IntPtr]::Zero)) {
            $controlWaits++
            if($controlWaits -eq 1) {
                Write-Output "WAIT native picker controls action=$Action editor=$([bool]$edit) button=$([bool]$button)"
                $dialogClass=[Text.StringBuilder]::new(128);[void][NativeImportTestWindow]::GetClassName($handle,$dialogClass,128);Write-Output "KNOWN picker Win32 class=$dialogClass"
                foreach($controlId in @(1,2)) {
                    $knownHandle=[NativeImportTestWindow]::GetDlgItem($handle,$controlId)
                    $controlClass=[Text.StringBuilder]::new(128);[void][NativeImportTestWindow]::GetClassName($knownHandle,$controlClass,128)
                    if($controlClass.ToString() -eq 'Button'){$label=[Text.StringBuilder]::new(128);[void][NativeImportTestWindow]::GetWindowText($knownHandle,$label,128);Write-Output "KNOWN native Button id=$controlId label=$label"} else {Write-Output "KNOWN native id=$controlId class=$controlClass present=$($knownHandle -ne [IntPtr]::Zero)"}
                }
                if($nativeEditorFallback) {
                    $known=[Collections.Generic.List[string]]::new()
                    $describe=[NativeImportTestWindow+Callback]{param($child,$unused)
                        $class=Get-NativeClass $child
                        if($class -match '^(Edit|ComboBox)'){$known.Add("$class/$([NativeImportTestWindow]::GetDlgCtrlID($child))")}
                        return $true
                    }
                    [void][NativeImportTestWindow]::EnumChildWindows($handle,$describe,[IntPtr]::Zero)
                    Write-Output "KNOWN edit/combo classes and IDs: $($known -join ', ')"
                }
            }
            $dialog=$null
        }
    }
    if($dialog) { break }; Start-Sleep -Milliseconds 100
}
if(!$dialog) {
    if($lastPicker -and !$nativeEditorFallback) {
        # Diagnostics are bounded to the exact owned test picker, never the desktop tree.
        $nodes=$lastPicker.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.Condition]::TrueCondition)
        Write-Output "PICKER diagnostic target=$TargetProcessId children=$($nodes.Count) rootType=$($lastPicker.Current.ControlType.ProgrammaticName) rootProcess=$($lastPicker.Current.ProcessId)"
        for($i=0;$i -lt [Math]::Min(30,$nodes.Count);$i++) { $node=$nodes[$i].Current;Write-Output "CONTROL type=$($node.ControlType.ProgrammaticName) id=$($node.AutomationId) enabled=$($node.IsEnabled) offscreen=$($node.IsOffscreen)" }
    }
    throw "The native picker controls were not ready in the test process: purpose=$Purpose action=$Action attempts=$attempt controlWaits=$controlWaits"
}
Write-Output "READY native picker action=$Action attempts=$attempt controlWaits=$controlWaits"
function Set-PickerText([string]$value) {
    if($edit){$edit.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($value)}
    elseif($nativeEdit -ne [IntPtr]::Zero){if([NativeImportTestWindow]::SetText($nativeEdit,0x000C,[IntPtr]::Zero,$value) -eq [IntPtr]::Zero){throw 'Native filename WM_SETTEXT failed.'}}
    else {throw 'Native filename control was not proven.'}
}
if($Action -eq 'select') {
    Set-PickerText $resolved
}
if($button -eq [IntPtr]::Zero) { throw 'Proven native picker button was not found.' }
[void][NativeImportTestWindow]::SetForegroundWindow($handle)
if(![NativeImportTestWindow]::PostMessageW($button,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'Native button click was not queued.'}
Write-Output "PASS native $Purpose picker $Action (owned #32770, exact Button ID/class/label, real BM_CLICK)"
