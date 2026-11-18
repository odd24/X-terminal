param(
    [string] $Archive,
    [string] $VisualStudio,
    [switch] $WithService
)

$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (!$Archive) { $Archive = Join-Path $repo '.tools/putty/putty-0.85.tar.gz' }
$Archive = (Resolve-Path -LiteralPath $Archive).Path
$expected = '13fd4db2936d03b73812a7bcc2a658e4dd29cc776a56c3670a7fc6f1a0ee8af8'
if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash -ne $expected) {
    throw 'PuTTY 0.85 source archive hash mismatch'
}
if (!$VisualStudio) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
    $VisualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($LASTEXITCODE -ne 0 -or !$VisualStudio) { throw 'MSVC x64 toolchain not found' }
}
Import-Module (Join-Path $VisualStudio 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $VisualStudio -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
. (Join-Path $PSScriptRoot 'Enter-Toolchain.ps1')
$cmakeRoot = Join-Path $VisualStudio 'Common7/IDE/CommonExtensions/Microsoft/CMake'
$cmake = Join-Path $cmakeRoot 'CMake/bin/cmake.exe'
$env:PATH = "$(Join-Path $cmakeRoot 'Ninja');$env:PATH"
$directory = Join-Path ([System.IO.Path]::GetTempPath()) "P13-ssh1-helper-$([Guid]::NewGuid())"
New-Item -ItemType Directory -Path $directory | Out-Null
Write-Output "SSH1_BUILD=$directory"

function Invoke-Build([scriptblock] $Action) {
    & $Action
    if ($LASTEXITCODE -ne 0) { throw "SSH1 helper build exited $LASTEXITCODE while running $Action" }
}

function Copy-VerifiedFile([string] $Source, [string] $Destination) {
    $hash = (Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLowerInvariant()
    Copy-Item -LiteralPath $Source -Destination $Destination
    if ((Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash -ne $hash) {
        throw 'Staged SSH1 file hash mismatch'
    }
    return $hash
}

$previousNative = $env:SSH1_NATIVE_DIR
$previousPin = $env:P13_SSH1_HELPER_SHA256
Push-Location -LiteralPath $directory
try {
    Invoke-Build { tar.exe -xzf $Archive }
    $source = Join-Path $directory 'putty-0.85'
    $licence = Copy-VerifiedFile (Join-Path $source 'LICENCE') (Join-Path $directory 'PuTTY-LICENCE.txt')
    if ($licence -ne '3b02f87e0063430289d9681727a98818c844fc8a4d79b24b76047fa061e77f13') {
        throw 'PuTTY 0.85 licence hash mismatch'
    }
    Invoke-Build { & $cmake -S putty-0.85 -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DPUTTY_GSSAPI=OFF }
    Invoke-Build { & $cmake --build build --target plink --parallel 2 *> putty-build.log }
    $includes = @("/I$source", "/I$source/windows", "/I$directory/build/generated")
    $storage = @('/Dcheck_stored_host_key=p13_unused_allow_lookup', '/Dstore_host_key=p13_unused_store')
    Invoke-Build { cl.exe /nologo /MD /O2 @includes @storage /c /Fono-storage.obj "$source/stubs/no-storage.c" }
    Copy-Item -LiteralPath "$repo/crates/transport-ssh1/native/owner.c" -Destination $directory
    Invoke-Build { cl.exe /nologo /MD /O2 @includes /c /Foowner.obj owner.c }
    $env:SSH1_NATIVE_DIR = $directory
    $cargoArgs = @('build', '--manifest-path', "$repo/Cargo.toml", '--locked', '--release', '--target',
        'x86_64-pc-windows-msvc', '--target-dir', "$repo/target", '-p', 'transport-ssh1',
        '--features', 'native-helper', '--bin', 'ssh1-helper')
    Push-Location -LiteralPath $repo
    try {
        Invoke-Build { cargo @cargoArgs }
    } finally {
        Pop-Location
    }
    $helper = Join-Path $directory 'ssh1-helper.exe'
    $pin = Copy-VerifiedFile "$repo/target/x86_64-pc-windows-msvc/release/ssh1-helper.exe" $helper
    $map = Get-Content -Raw -LiteralPath (Join-Path $directory 'ssh1-helper.map')
    if ($map -match '\bsettings:storage\.c\.obj\b' -or
        $map -notmatch '(?m)^\s+\S+\s+check_stored_host_key\s+[^\r\n]+\bowner\.obj\s*$' -or
        $map -notmatch '(?m)^\s+\S+\s+store_host_key\s+[^\r\n]+\bowner\.obj\s*$') {
        throw 'SSH1 helper host storage link guard failed'
    }
    Write-Output "SSH1_HELPER=$directory/ssh1-helper.exe"
    if ($WithService) {
        $env:P13_SSH1_HELPER_SHA256 = $pin
        $serviceArgs = @('build', '--manifest-path', "$repo/Cargo.toml", '--locked', '--target',
            'x86_64-pc-windows-msvc', '--target-dir', "$repo/target", '-p', 'session-service',
            '--features', 'ssh1-with-helper', '--bin', 'session-service')
        Push-Location -LiteralPath $repo
        try {
            Invoke-Build { cargo @serviceArgs }
        } finally {
            Pop-Location
        }
        $service = Copy-VerifiedFile "$repo/target/x86_64-pc-windows-msvc/debug/session-service.exe" (Join-Path $directory 'session-service.exe')
        if ((Get-FileHash -LiteralPath $helper -Algorithm SHA256).Hash -ne $pin) {
            throw 'Paired SSH1 helper no longer matches the pinned build'
        }
        @{
            version = 1
            archive_sha256 = $expected
            files = @{
                'session-service.exe' = $service
                'ssh1-helper.exe' = $pin
                'PuTTY-LICENCE.txt' = $licence
            }
        } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $directory 'ssh1-build-manifest.json') -Encoding utf8
        Write-Output "SSH1_SERVICE=$directory/session-service.exe"
    }
} finally {
    $env:SSH1_NATIVE_DIR = $previousNative
    $env:P13_SSH1_HELPER_SHA256 = $previousPin
    Pop-Location
}
