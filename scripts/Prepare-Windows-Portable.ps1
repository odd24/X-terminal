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
        distribution='portable';sourceCommit=$commit;identifier=$tauri.identifier;mcpCatalogVersion=12
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
    node scripts/Test-Desktop-LocalScripts.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Local script regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-LocalDirectory.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Local directory regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-LocalTabs.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Local tab regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-SessionCopy.mjs $desktop --tab-interactions --webview-pointer
    if ($LASTEXITCODE -ne 0) { throw "Mixed local and SSH tab regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-ShortcutPreview.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Shortcut alias and preview regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-ShortcutRoutes.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "SSH and local shortcut routes failed. Candidate: $staging" }
    $previousTarget = $env:CARGO_TARGET_DIR
    $env:CARGO_TARGET_DIR = Join-Path $repo 'target/desktop-shortcuts-memory-uart'
    try {
        cargo build -p session-service --locked --features serial-ui-fixture
        if ($LASTEXITCODE -ne 0) { throw 'Memory UART fixture build failed' }
        $uartService = Join-Path $env:CARGO_TARGET_DIR 'debug/session-service.exe'
    } finally {
        if ($null -eq $previousTarget) { Remove-Item Env:CARGO_TARGET_DIR }
        else { $env:CARGO_TARGET_DIR = $previousTarget }
    }
    $uartStage = Join-Path $staging 'memory-uart'
    New-Item -ItemType Directory -Path $uartStage | Out-Null
    $uartDesktop = Join-Path $uartStage 'shared-terminal-desktop.exe'
    Copy-Item -LiteralPath $desktop -Destination $uartDesktop
    Copy-Item -LiteralPath $uartService -Destination (Join-Path $uartStage 'session-service.exe')
    node scripts/Test-Desktop-ShortcutRoutes.mjs $uartDesktop --uart
    if ($LASTEXITCODE -ne 0) { throw "Memory UART shortcut routes failed. Candidate: $staging" }
    node scripts/Test-Desktop-ShortcutManagement.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Shortcut management regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-Shortcuts.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Desktop keyboard shortcut regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-McpShortcuts.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Desktop MCP shortcut management failed. Candidate: $staging" }
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
    $scripts = Get-Content -LiteralPath 'artifacts/local-scripts-software-result.json' -Raw | ConvertFrom-Json
    $directory = Get-Content -LiteralPath 'artifacts/local-directory-software-result.json' -Raw | ConvertFrom-Json
    $localTabs = Get-Content -LiteralPath 'artifacts/local-tabs-software-result.json' -Raw | ConvertFrom-Json
    $mixedTabs = Get-Content -LiteralPath "artifacts/windows-$version-session-copy-ssh.json" -Raw | ConvertFrom-Json
    $shortcutPreview = Get-Content -LiteralPath "artifacts/windows-$version-shortcuts-preview-result.json" -Raw | ConvertFrom-Json
    $shortcutSsh = Get-Content -LiteralPath "artifacts/windows-$version-shortcut-routes-ssh.json" -Raw | ConvertFrom-Json
    $shortcutUart = Get-Content -LiteralPath "artifacts/windows-$version-shortcut-routes-uart.json" -Raw | ConvertFrom-Json
    $desktopHash = ($files | Where-Object name -eq 'shared-terminal-desktop.exe').sha256
    $shortcutManagement = Get-Content -LiteralPath 'artifacts/shortcut-management-software-result.json' -Raw | ConvertFrom-Json
    $desktopShortcuts = Get-Content -LiteralPath 'artifacts/desktop-shortcuts-software-result.json' -Raw | ConvertFrom-Json
    $mcpShortcuts = Get-Content -LiteralPath 'artifacts/mcp-shortcuts-software-result.json' -Raw | ConvertFrom-Json
    if ($verified.result -ne 'PASS' -or $mcp.result -ne 'PASS' -or $mcp.preview -ne $unpacked -or
        $local.result -ne 'PASS' -or $local.executable -ne $desktop -or $adb.result -ne 'PASS' -or $adb.executable -ne $desktop -or
        $powershell.result -ne 'PASS' -or $powershell.executable -ne $desktop -or
        $scripts.result -ne 'PASS' -or $scripts.executable -ne $desktop -or
        $directory.result -ne 'PASS' -or $directory.executable -ne $desktop -or
        $localTabs.result -ne 'PASS' -or $localTabs.executable -ne $desktop -or $localTabs.sha256 -ne $desktopHash -or
        !$localTabs.nativeMouse -or !$localTabs.nativeDoubleClick -or
        $mixedTabs.result -ne 'PASS' -or $mixedTabs.executable -ne $desktop -or $mixedTabs.desktopSha256 -ne $desktopHash -or
        $shortcutPreview.result -ne 'PASS' -or $shortcutPreview.executable -ne $desktop -or $shortcutPreview.sha256 -ne $desktopHash -or
        $shortcutSsh.result -ne 'PASS' -or $shortcutSsh.executable -ne $desktop -or $shortcutSsh.sha256 -ne $desktopHash -or
        $shortcutUart.result -ne 'PASS' -or $shortcutUart.executable -ne $uartDesktop -or $shortcutUart.sha256 -ne $desktopHash -or
        $shortcutManagement.result -ne 'PASS' -or $shortcutManagement.executable -ne $desktop -or
        $desktopShortcuts.result -ne 'PASS' -or $desktopShortcuts.executable -ne $desktop -or
        $mcpShortcuts.result -ne 'PASS' -or $mcpShortcuts.executable -ne $desktop) {
        throw 'Release evidence mismatch'
    }
    $report = [ordered]@{result='PASS';version=$version;sourceCommit=$commit;directoryOnly=[bool]$DirectoryOnly;zipSha256=$sha256;smoke=$verified;terminalRead=$mcp.read;terminalReadClose=$mcp.close;localTerminal=$local;adbShortcuts=$adb;powerShell=$powershell;localScripts=$scripts;localDirectory=$directory;localTabs=$localTabs;mixedTabs=$mixedTabs;shortcutPreview=$shortcutPreview;shortcutSsh=$shortcutSsh;shortcutUart=$shortcutUart;shortcutManagement=$shortcutManagement;desktopShortcuts=$desktopShortcuts;mcpShortcuts=$mcpShortcuts}
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
