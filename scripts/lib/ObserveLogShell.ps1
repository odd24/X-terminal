param([Parameter(Mandatory)][string]$Root,[Parameter(Mandatory)][string]$TargetPath,[Parameter(Mandatory)][ValidateSet('directory','saved-directory','script-directory','script-file','file','system-file')][string]$Action,[string]$LogId,[string]$ExistingExplorerWindows='[]')
$ErrorActionPreference='Stop'
$ErrorView='NormalView'
trap { Write-Output $_.ScriptStackTrace; break }
$rootFull=[IO.Path]::GetFullPath($Root)
$tempFull=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd([IO.Path]::DirectorySeparatorChar)
$name=[IO.Path]::GetFileName($rootFull)
$rootPattern=if($Action -eq 'saved-directory'){'^shared-terminal-save-ui-中文-'}elseif($Action -in @('script-directory','script-file')){'^shared-terminal-local-scripts-中文-'}else{'^shared-terminal-(log-menu|pane-groups|log-viewer)-ui-中文-'}
if ([IO.Path]::GetDirectoryName($rootFull) -ne $tempFull -or $name -notmatch $rootPattern) { throw 'Only an owned log-test root is allowed.' }
$targetFull=[IO.Path]::GetFullPath($TargetPath)
$common=[IO.Path]::Combine($rootFull,'logs')
if (($Action -eq 'directory' -and $targetFull -ne $common) -or ($Action -eq 'saved-directory' -and $targetFull -ne $rootFull) -or
    ($Action -eq 'script-directory' -and [IO.Path]::GetDirectoryName($targetFull) -ne $rootFull) -or
    ($Action -eq 'script-file' -and ([IO.Path]::GetDirectoryName([IO.Path]::GetDirectoryName($targetFull)) -ne $rootFull -or [IO.Path]::GetExtension($targetFull) -notin @('.bat','.cmd'))) -or
    ($Action -in @('file','system-file') -and ([IO.Path]::GetDirectoryName($targetFull) -ne $common -or [IO.Path]::GetExtension($targetFull) -ne '.log' -or $LogId -notmatch '^[0-9a-f-]{36}$'))) { throw 'Refuse an unrelated shell target.' }
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class LogShellLongPath {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern uint GetLongPathName(string path,StringBuilder output,uint size);
 [DllImport("shlwapi.dll",CharSet=CharSet.Unicode)] static extern int AssocQueryStringW(int flags,int kind,string extension,string verb,StringBuilder output,ref uint size);
 public static string Of(string path) { var b=new StringBuilder(32768); var n=GetLongPathName(path,b,(uint)b.Capacity); if(n==0||n>=b.Capacity)throw new InvalidOperationException("cannot normalize existing test path"); return b.ToString(); }
 public static string LogApplication() { var b=new StringBuilder(32768); uint n=(uint)b.Capacity; return AssocQueryStringW(0,2,".log","open",b,ref n)==0 ? b.ToString() : ""; }
}
'@
$expected=[LogShellLongPath]::Of($targetFull)
if ($Action -in @('directory','saved-directory','script-directory','script-file')) {
 $shell=New-Object -ComObject Shell.Application
 $existing=@($ExistingExplorerWindows|ConvertFrom-Json)
 $label=switch ($Action) {'script-file'{'owned script selection'} 'script-directory'{'owned test directory'} default{'shared test log directory'}}
 $folder=if($Action -eq 'script-file'){[IO.Path]::GetDirectoryName($expected)}else{$expected}
 for($n=0;$n -lt 100;$n++) {
  foreach($window in @($shell.Windows())) {
   try {
    if ([LogShellLongPath]::Of([string]$window.Document.Folder.Self.Path) -ne $folder) { continue }
    if ($Action -eq 'script-file') {
     $selected=$window.Document.SelectedItems()
     if ($selected.Count -ne 1 -or [LogShellLongPath]::Of([string]$selected.Item(0).Path) -ne $expected) { continue }
    }
    if($existing -contains [string]$window.HWND) {
     Write-Output "PASS exact $label in an existing Explorer window"
    } else {
     $window.Quit()
     Write-Output "PASS exact $label observed in Explorer and its own window closed"
    }
    exit 0
   } catch {}
  }
  Start-Sleep -Milliseconds 100
 }
 throw 'The exact owned location or selection was not observed in Explorer.'
}
if ($Action -eq 'system-file') {
 $application=[LogShellLongPath]::LogApplication()
 $program=[IO.Path]::GetFileNameWithoutExtension($application)
 if ($program -and $program -ne 'notepad') {
  $filename=[IO.Path]::GetFileName($expected)
  for($n=0;$n -lt 100;$n++) {
   foreach($editor in @(Get-Process -Name $program -ErrorAction SilentlyContinue)) {
    try {
     if(!$editor.Path -or [LogShellLongPath]::Of($editor.Path) -ne [LogShellLongPath]::Of($application)) { continue }
     $title=$editor.MainWindowTitle
     if($title -eq $expected -or $title.StartsWith($expected+' - ',[StringComparison]::OrdinalIgnoreCase) -or
          $title -eq $filename -or $title.StartsWith($filename+' - ',[StringComparison]::OrdinalIgnoreCase)) {
      Write-Output "PASS actual system default program opened the owned log ($program)"
      exit 0
     }
    } catch {}
   }
   Start-Sleep -Milliseconds 100
  }
  throw 'The current system default program did not show the exact owned log name.'
 }
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$name=[IO.Path]::GetFileName($targetFull)
$desktop=[Windows.Automation.AutomationElement]::RootElement
$windowType=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Window)
for($n=0;$n -lt 100;$n++) {
 foreach($window in $desktop.FindAll([Windows.Automation.TreeScope]::Children,$windowType)) {
  if (!([string]$window.Current.Name).Contains($name)) { continue }
  $process=Get-Process -Id $window.Current.ProcessId -ErrorAction SilentlyContinue
  if (!$process -or $process.ProcessName -notmatch '^notepad$') { continue }
  $owned=$false
  $documents=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.OrCondition]::new([Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Document),[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Edit)))
  foreach($document in $documents) { $pattern=$null; if ($document.TryGetCurrentPattern([Windows.Automation.TextPattern]::Pattern,[ref]$pattern)) { if (([string]$pattern.DocumentRange.GetText(8192)).Contains($LogId)) { $owned=$true;break } } }
  if (!$owned -and $documents.Count -eq 0) {
   # Some Win11 Notepad builds omit the editor TextPattern. Independently
   # recognize the exact header from its own rendered content, without keys.
   Add-Type -AssemblyName System.Drawing
   Add-Type -TypeDefinition @"
using System;using System.Runtime.InteropServices;
public static class OwnLogEditorImage {
 [StructLayout(LayoutKind.Sequential)]public struct Rect{public int L,T,R,B;}
 [DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr w,out Rect r);
 [DllImport("user32.dll")]public static extern bool PrintWindow(IntPtr w,IntPtr dc,uint flags);
}
"@
   for($renderAttempt=0;$renderAttempt -lt 8;$renderAttempt++) {
   $handle=[IntPtr]$window.Current.NativeWindowHandle;$rect=[OwnLogEditorImage+Rect]::new()
   if(![OwnLogEditorImage]::GetWindowRect($handle,[ref]$rect)){throw 'Own editor geometry unavailable.'}
   $bitmap=[Drawing.Bitmap]::new($rect.R-$rect.L,$rect.B-$rect.T);$graphics=[Drawing.Graphics]::FromImage($bitmap);$dc=$graphics.GetHdc()
   try{if(![OwnLogEditorImage]::PrintWindow($handle,$dc,2)){throw 'Own editor capture failed.'}}finally{$graphics.ReleaseHdc($dc);$graphics.Dispose()}
   try{$crop=$bitmap.Clone([Drawing.Rectangle]::new(8,75,[Math]::Min(1000,$bitmap.Width-16),[Math]::Min(220,$bitmap.Height-100)),$bitmap.PixelFormat);try{$scaled=[Drawing.Bitmap]::new($crop,$crop.Width*2,$crop.Height*2);try{$image=[IO.Path]::Combine($rootFull,'log-shell-header.png');$scaled.Save($image)}finally{$scaled.Dispose()}}finally{$crop.Dispose()}}finally{$bitmap.Dispose()}
   # WinRT projections are available in inbox Windows PowerShell. Execute the
   # fixed, reviewed read-only OCR command without changing execution policy.
   $code=[IO.File]::ReadAllText([IO.Path]::Combine($PSScriptRoot,'Read-OwnedLogImage.ps1'))
   $command="& {`n$code`n} -ImagePath '"+$image.Replace("'","''")+"' -LogId '"+$LogId+"'"
   $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
   $verification=& "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -EncodedCommand $encoded 2>&1
   if($LASTEXITCODE -eq 0){$owned=$true;break};Start-Sleep -Milliseconds 100
   }
   if(!$owned){throw 'Exact editor header image verification failed after bounded load observation.'}
  }
  if (!$owned) { continue }
  $tabs=$window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem))
  foreach($tab in $tabs) {
   if (!([string]$tab.Current.Name).Contains($name)) { continue }
   foreach($button in $tab.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))) {
    $invoke=$null
    if ($button.Current.Name -match '关闭|Close' -and $button.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$invoke)) { $invoke.Invoke();Write-Output 'PASS actual readable log and exact header observed in Notepad; only its own tab closed';exit 0 }
   }
  }
  # Classic single-document Notepad only; never close a modern shared tab host.
  if ($tabs.Count -eq 0 -and $process.Path -eq [IO.Path]::Combine($env:SystemRoot,'System32','notepad.exe')) {
   $pattern=$null;if($window.TryGetCurrentPattern([Windows.Automation.WindowPattern]::Pattern,[ref]$pattern)){$pattern.Close();Write-Output 'PASS actual readable log and exact header observed in classic Notepad; own file window closed';exit 0}
  }
  throw 'Owned file was observed, but a safe own-tab close control was unavailable; unrelated windows were left untouched.'
 }
 Start-Sleep -Milliseconds 100
}
throw 'The exact readable log/header was not observed in Notepad.'
