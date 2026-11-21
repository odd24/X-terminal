param([switch]$DirectoryOnly)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $repo
try {
    $version = (Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json).version
    $tauri = Get-Content -LiteralPath 'apps/desktop/src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $tauri.version -ne $version) { throw 'Version files do not match the release' }
    $commit = (git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or $commit -notmatch '^[0-9a-f]{40}$') { throw 'Cannot resolve source commit' }
    $triple = 'x86_64-pc-windows-msvc'
    $artifactName = "SharedTerminal-$version-windows-x64"
    $source = Join-Path $repo "target/windows-x64-portable/$triple/release"
    $artifacts = (Resolve-Path -LiteralPath 'artifacts').Path
    $destinations = if ($DirectoryOnly) { @($artifactName, "$artifactName-verification.json") } else {
        @($artifactName, "$artifactName.zip", "$artifactName.zip.sha256", "$artifactName-verification.json")
    }
    foreach ($name in $destinations) {
        if (Test-Path -LiteralPath (Join-Path $artifacts $name)) { throw "Delivery path already exists: $name" }
    }
    $staging = Join-Path $artifacts ('.windows-portable-'+[Guid]::NewGuid())
    $candidate = Join-Path $staging $artifactName
    New-Item -ItemType Directory -Path $candidate | Out-Null
    $files = @(
        foreach ($name in @('shared-terminal-desktop.exe','session-service.exe','terminal-mcp.exe','README.md')) {
            $binary = $name.EndsWith('.exe')
            $destination = Join-Path $candidate $name
            if ($binary) {
                $inputFile = Join-Path $source $name
                Copy-Item -LiteralPath $inputFile -Destination $destination
            } else {
                $readme = git show "${commit}:docs/WINDOWS_PORTABLE.md"
                if ($LASTEXITCODE -ne 0 -or !$readme) { throw 'Cannot read the release README at the source commit' }
                [IO.File]::WriteAllText($destination, ($readme -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
            }
            $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($binary -and $hash -ne (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant()) {
                throw "Copy hash mismatch for $name"
            }
            $file = [ordered]@{name=$name;version=$version;bytes=(Get-Item -LiteralPath $destination).Length;sha256=$hash}
            if ($binary) {
                $signature = (Get-AuthenticodeSignature -LiteralPath $destination).Status.ToString()
                if ($signature -ne 'NotSigned') { throw "Unexpected signing status for $name ($signature)" }
                $file.authenticode = $signature
            }
            $file
        }
    )
    $manifest = [ordered]@{
        format=1;product='Shared Terminal';version=$version;target=$triple;buildProfile='release'
        distribution='portable';sourceCommit=$commit;identifier=$tauri.identifier
        signed=$false;files=$files
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $candidate 'manifest.json') -Encoding utf8
    $archive = Join-Path $staging "$artifactName.zip"
    $unpacked = $candidate
    if (!$DirectoryOnly) {
        Compress-Archive -LiteralPath $candidate -DestinationPath $archive -CompressionLevel Optimal
        $extracted = Join-Path $staging 'extracted'
        Expand-Archive -LiteralPath $archive -DestinationPath $extracted
        $unpacked = Join-Path $extracted $artifactName
    }
    $evidence = Join-Path $staging "$artifactName-verification.json"
    node scripts/Test-Windows-Portable.mjs $unpacked $evidence
    if ($LASTEXITCODE -ne 0) { throw "Extracted release smoke failed. Candidate: $staging" }
    node scripts/Test-Desktop-Mcp.mjs --official-client --read-boundaries (Join-Path $unpacked 'manifest.json')
    if ($LASTEXITCODE -ne 0) { throw "Extracted release MCP read regression failed. Candidate: $staging" }
    $desktop = Join-Path $unpacked 'shared-terminal-desktop.exe'
    node scripts/Test-Desktop-LocalTerminal.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Extracted local terminal regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-LocalAdb.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Extracted ADB shortcut regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-LocalPowerShell.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "PowerShell regression failed. Candidate: $staging" }
    $sha256 = $null
    if (!$DirectoryOnly) {
        $sha256 = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
        "$sha256  $artifactName.zip" | Set-Content -LiteralPath (Join-Path $staging "$artifactName.zip.sha256") -Encoding ascii
    }
    $verified = Get-Content -LiteralPath $evidence -Raw | ConvertFrom-Json
    $mcp = Get-Content -LiteralPath 'artifacts/windows-x64-release-terminal-read-result.json' -Raw | ConvertFrom-Json
    $local = Get-Content -LiteralPath 'artifacts/local-terminal-software-result.json' -Raw | ConvertFrom-Json
    $adb = Get-Content -LiteralPath 'artifacts/local-adb-software-result.json' -Raw | ConvertFrom-Json
    $powershell = Get-Content -LiteralPath 'artifacts/local-powershell-software-result.json' -Raw | ConvertFrom-Json
    if ($verified.result -ne 'PASS' -or $mcp.result -ne 'PASS' -or $mcp.preview -ne $unpacked -or
        $local.result -ne 'PASS' -or $local.executable -ne $desktop -or $adb.result -ne 'PASS' -or $adb.executable -ne $desktop -or
        $powershell.result -ne 'PASS' -or $powershell.executable -ne $desktop) {
        throw 'Release evidence mismatch'
    }
    $report = [ordered]@{result='PASS';version=$version;sourceCommit=$commit;directoryOnly=[bool]$DirectoryOnly;zipSha256=$sha256;smoke=$verified;terminalRead=$mcp.read;terminalReadClose=$mcp.close;localTerminal=$local;adbShortcuts=$adb;powerShell=$powershell}
    $report | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $evidence -Encoding utf8

    $resolvedStage = (Resolve-Path -LiteralPath $staging).Path
    if ((Split-Path -Parent $resolvedStage) -ne $artifacts -or (Split-Path -Leaf $resolvedStage) -notmatch '^\.windows-portable-[0-9a-f-]+$') {
        throw 'Invalid staging path'
    }
    foreach ($name in $destinations) {
        $from = (Resolve-Path -LiteralPath (Join-Path $resolvedStage $name)).Path
        $to = Join-Path $artifacts $name
        if ((Split-Path -Parent $from) -ne $resolvedStage -or (Split-Path -Parent $to) -ne $artifacts -or (Test-Path -LiteralPath $to)) {
            throw "Invalid delivery path: $name"
        }
        Move-Item -LiteralPath $from -Destination $to
    }
    Remove-Item -LiteralPath $resolvedStage -Recurse
    if ($DirectoryOnly) { Write-Output "PASS $artifactName | executable directory" }
    else { Write-Output "PASS $artifactName | SHA-256 $sha256" }
} finally {
    Pop-Location
}
