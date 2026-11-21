param([Parameter(Mandatory)][string]$ImagePath,[Parameter(Mandatory)][string]$LogId)
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$parent=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($ImagePath))
if([IO.Path]::GetDirectoryName($parent) -ne [IO.Path]::GetTempPath().TrimEnd('\') -or [IO.Path]::GetFileName($parent) -notmatch '^shared-terminal-(log-menu|pane-groups|log-viewer)-ui-' -or [IO.Path]::GetFileName($ImagePath) -ne 'log-shell-header.png' -or $LogId -notmatch '^[0-9a-f-]{36}$'){throw 'Unrelated OCR input refused.'}
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]|Out-Null
[Windows.Storage.Streams.IRandomAccessStream,Windows.Storage.Streams,ContentType=WindowsRuntime]|Out-Null
[Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null
[Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]|Out-Null
[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null
[Windows.Media.Ocr.OcrResult,Windows.Foundation,ContentType=WindowsRuntime]|Out-Null
[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]|Out-Null
$method=[System.WindowsRuntimeSystemExtensions].GetMethods()|Where-Object {$_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1}|Select-Object -First 1
function Wait-OwnImage($operation,[type]$resultType){$task=$method.MakeGenericMethod($resultType).Invoke($null,@($operation));$task.Wait();return $task.Result}
$file=Wait-OwnImage ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
$stream=Wait-OwnImage ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try{
 $decoder=Wait-OwnImage ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
 $bitmap=Wait-OwnImage ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
 try{$engine=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('en-US'));if(!$engine){throw 'English OCR is unavailable.'};$result=Wait-OwnImage ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult]);# Only non-hex OCR glyphs are normalized; every one of the 32 hex digits must match.
 $actual=($result.Text -replace '[^0-9a-zA-Z]','').ToLowerInvariant();$actual=$actual.Replace('o','0').Replace('i','1').Replace('l','1');if(!$actual.Contains($LogId.Replace('-',''))){throw 'Visible image did not contain the exact original log ID.'};Write-Output 'PASS exact visible synthetic log header independently recognized; no text emitted.'}finally{$bitmap.Dispose()}
}finally{$stream.Dispose()}
