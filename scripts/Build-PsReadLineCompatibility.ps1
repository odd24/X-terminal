param(
    [Parameter(Mandatory)][string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
$archive = Join-Path $PSScriptRoot '../vendor/psreadline/PSReadLine-2.0.0.tar.gz'
$expected = 'A929426A7590D06ACDAD0ADA3B73F6C584410EAE9D4F9465A8DD072044FF2BA0'
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) {
    throw 'PSReadLine upstream source hash mismatch'
}

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$compiler = & $vswhere -latest -products '*' -find 'MSBuild\**\Roslyn\csc.exe' | Select-Object -First 1
if (!$compiler) { throw 'MSBuild Roslyn compiler is required for Windows desktop builds' }
$automation = Join-Path $env:SystemRoot 'Microsoft.NET/assembly/GAC_MSIL/System.Management.Automation/v4.0_3.0.0.0__31bf3856ad364e35/System.Management.Automation.dll'
if (!(Test-Path -LiteralPath $automation -PathType Leaf)) { throw 'Windows PowerShell 5.1 reference assembly not found' }

New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
$sourceStage = Join-Path $OutputDirectory ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $sourceStage | Out-Null
try {
    tar.exe -xzf $archive -C $sourceStage
    if ($LASTEXITCODE) { throw 'Cannot extract pinned PSReadLine' }
    $source = Join-Path $sourceStage 'PSReadLine-2.0.0/PSReadLine'
    $editor = Join-Path $source 'ReadLine.cs'
    $text = [IO.File]::ReadAllText($editor)
    $before = 'var y = console.CursorTop;\s+ps\.Invoke\(\);\s+if \(y != console\.CursorTop\)'
    if ([regex]::Matches($text, $before).Count -ne 1) { throw 'Unexpected PSReadLine input loop' }
    # An edit renders within the idle event pipeline. Its vertical movement is
    # not external console output and must not move the next render origin.
    # This is the buffer-length guard in upstream PSReadLine 2.4.5 ReadKey.
    $after = @'
var y = console.CursorTop;
                            var bufferLength = _singleton._buffer.Length;
                            ps.Invoke();
                            if (y != console.CursorTop && bufferLength == _singleton._buffer.Length)
'@
    [IO.File]::WriteAllText($editor, [regex]::Replace($text, $before, $after))
    $version = Join-Path $sourceStage 'AssemblyVersion.cs'
    @'
[assembly: System.Reflection.AssemblyVersion("2.0.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("2.0.0.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("2.0.0+shared-terminal")]
'@ | Set-Content -LiteralPath $version -Encoding utf8
    $resource = Join-Path $sourceStage 'PSReadLineResources.resources'
    $strings = [xml](Get-Content -LiteralPath (Join-Path $source 'PSReadLineResources.resx') -Raw -Encoding utf8)
    $writer = [System.Resources.ResourceWriter]::new($resource)
    try {
        foreach ($item in $strings.root.data) {
            if ($item.type) { throw 'Unexpected non-string PSReadLine resource' }
            $writer.AddResource([string]$item.name, [string]$item.value)
        }
    } finally { $writer.Dispose() }
    $files = @(Get-ChildItem -LiteralPath $source -Filter '*.cs' -File | Sort-Object Name | ForEach-Object FullName) + @($version)
    $binary = Join-Path $OutputDirectory 'Microsoft.PowerShell.PSReadLine2.dll'
    $notice = Join-Path $source 'License.txt'
    & $compiler /nologo /target:library /optimize+ /deterministic+ "/out:$binary" "/r:$automation" `
        "/resource:$resource,Microsoft.PowerShell.PSReadLine.PSReadLineResources.resources" "/resource:$notice,PSReadLine.LICENSE.txt" @files
    if ($LASTEXITCODE) { throw 'PSReadLine compilation failed' }
} finally {
    $resolvedOutput = (Resolve-Path -LiteralPath $OutputDirectory).Path
    $resolvedStage = (Resolve-Path -LiteralPath $sourceStage).Path
    if ((Split-Path -Parent $resolvedStage) -ceq $resolvedOutput) {
        Remove-Item -LiteralPath $resolvedStage -Recurse -Force
    }
}
