param([switch]$DirectoryOnly)
$ErrorActionPreference = 'Stop'

function Assert-UnsignedPe([string]$Path) {
    $image = [IO.File]::ReadAllBytes($Path)
    if ($image.Length -lt 64 -or [BitConverter]::ToUInt16($image, 0) -ne 0x5a4d) {
        throw "Missing DOS header: $Path"
    }
    $header = [BitConverter]::ToUInt32($image, 0x3c)
    $optional = $header + 24
    $certificate = $optional + 112 + 4 * 8
    if ($certificate + 8 -gt $image.Length -or [BitConverter]::ToUInt32($image, $header) -ne 0x4550 -or
        [BitConverter]::ToUInt16($image, $header + 20) -lt 152 -or
        [BitConverter]::ToUInt16($image, $optional) -ne 0x20b -or
        [BitConverter]::ToUInt32($image, $optional + 108) -le 4) {
        throw "Invalid PE32+ headers: $Path"
    }
    if ([BitConverter]::ToUInt64($image, $certificate) -ne 0) {
        throw "Unexpected embedded signature: $Path"
    }
}

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
                $psReadLineNotice = git show "${commit}:vendor/psreadline/LICENSE.txt"
                if ($LASTEXITCODE -ne 0 -or !$psReadLineNotice) { throw 'Cannot read the PSReadLine notice at the source commit' }
                $readme += @('', '## PSReadLine 2.0 license', '') + $psReadLineNotice
                foreach ($dependency in @('zip-8.6.0', 'typed-path-0.12.4')) {
                    $notice = git show "${commit}:docs/licenses/$dependency-MIT.txt"
                    if ($LASTEXITCODE -ne 0 -or !$notice) { throw "Missing release license notice: $dependency" }
                    $readme += @('', "## $dependency license", '') + $notice
                }
                [IO.File]::WriteAllText($destination, ($readme -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
            }
            $hash = (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($binary -and $hash -ne (Get-FileHash -LiteralPath $inputFile -Algorithm SHA256).Hash.ToLowerInvariant()) {
                throw "Copy hash mismatch for $name"
            }
            $file = [ordered]@{name=$name;version=$version;bytes=(Get-Item -LiteralPath $destination).Length;sha256=$hash}
            if ($binary) {
                if ($name -eq 'shared-terminal-desktop.exe') {
                    $versionInfo = (Get-Item -LiteralPath $destination).VersionInfo
                    if ($versionInfo.FileVersion -ne $version -or $versionInfo.ProductVersion -ne $version) {
                        throw "Embedded desktop version mismatch for $name"
                    }
                } else {
                    $reported = & $destination --version
                    if ($LASTEXITCODE -ne 0 -or $reported -cne "$([IO.Path]::GetFileNameWithoutExtension($name)) $version") {
                        throw "Reported executable version mismatch for $name"
                    }
                }
                Assert-UnsignedPe $destination
                $file.authenticode = 'NotSigned'
            }
            $file
        }
    )
    $manifest = [ordered]@{
        format=1;product='Shared Terminal';version=$version;target=$triple;buildProfile='release'
        distribution='portable';sourceCommit=$commit;identifier=$tauri.identifier;mcpCatalogVersion=14
        signed=$false;files=$files
    }
    $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $candidate 'manifest.json') -Encoding utf8
    $archive = Join-Path $staging "$artifactName.zip"
    $unpacked = $candidate
    if (!$DirectoryOnly) {
        [IO.Compression.ZipFile]::CreateFromDirectory($candidate, $archive, [IO.Compression.CompressionLevel]::Optimal, $true)
        $extracted = Join-Path $staging 'extracted'
        [IO.Compression.ZipFile]::ExtractToDirectory($archive, $extracted)
        $unpacked = Join-Path $extracted $artifactName
    }
    $evidence = Join-Path $staging "$artifactName-verification.json"
    node scripts/Test-Windows-Portable.mjs $unpacked $evidence
    if ($LASTEXITCODE -ne 0) { throw "Extracted release smoke failed. Candidate: $staging" }
    node scripts/Test-Desktop-Mcp.mjs --official-client --read-boundaries (Join-Path $unpacked 'manifest.json')
    if ($LASTEXITCODE -ne 0) { throw "Extracted release MCP read regression failed. Candidate: $staging" }
    $desktop = Join-Path $unpacked 'shared-terminal-desktop.exe'
    $desktopHash = ($files | Where-Object name -eq 'shared-terminal-desktop.exe').sha256
    $savedSshEvidence = Join-Path $staging 'saved-ssh.json'
    node scripts/Test-Desktop-SavedSshSetup.mjs $desktop $savedSshEvidence
    if ($LASTEXITCODE -ne 0) { throw "Extracted saved SSH2 setup failed. Candidate: $staging" }
    $fileDropEvidence = Join-Path $staging 'native-file-drop.json'
    node scripts/Test-Desktop-FileDrop.mjs $desktop $fileDropEvidence
    if ($LASTEXITCODE -ne 0) { throw "Extracted native file drop failed. Candidate: $staging" }
    $deletionEvidence = Join-Path $staging 'profile-deletion.json'
    node scripts/Test-Desktop-TreeActions.mjs $desktop $deletionEvidence "windows-$version"
    if ($LASTEXITCODE -ne 0) { throw "Extracted profile deletion failed. Candidate: $staging" }
    $contextMenuEvidence = Join-Path $staging 'context-menu.json'
    $oldContextMenu = Join-Path $artifacts 'SharedTerminal-0.1.38-windows-x64/shared-terminal-desktop.exe'
    node scripts/Test-Desktop-ContextMenuPolicy.mjs $desktop $oldContextMenu $contextMenuEvidence
    if ($LASTEXITCODE -ne 0) { throw "Extracted native context menu policy failed. Candidate: $staging" }
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
    $shortcutEditorEvidence = Join-Path $staging 'shortcut-editor.json'
    node scripts/Test-Desktop-ShortcutEditor.mjs $desktop $shortcutEditorEvidence
    if ($LASTEXITCODE -ne 0) { throw "Shortcut editor navigation failed. Candidate: $staging" }
    $newGates = @(
        @{name='treeTabs';script='Test-Desktop-TreeTabs';file='tree-tabs.json';options=@()},
        @{name='shortcutStop';script='Test-Desktop-ShortcutAutoClose';file='shortcut-stop.json';options=@()},
        @{name='pasteEditor';script='Test-Desktop-LocalPasteEditor';file='paste-editor.json';options=@()},
        @{name='shortcutPackage';script='Test-Desktop-ShortcutPackage';file='shortcut-package.json';options=@('--native-picker')},
        @{name='exportLayout';script='Test-Desktop-ShortcutExportLayout';file='export-layout.json';options=@()}
    )
    foreach ($gate in $newGates) {
        $options = $gate.options
        node "scripts/$($gate.script).mjs" $desktop (Join-Path $staging $gate.file) @options
        if ($LASTEXITCODE -ne 0) { throw "Release feature gate failed: $($gate.name). Candidate: $staging" }
    }
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
    $serialConfigEvidence = Join-Path $staging 'serial-config.json'
    node scripts/Test-Desktop-SerialConfig.mjs $uartDesktop $serialConfigEvidence
    if ($LASTEXITCODE -ne 0) { throw "Extracted serial configuration failed. Candidate: $staging" }
    node scripts/Test-Desktop-ShortcutManagement.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Shortcut management regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-Shortcuts.mjs $desktop
    if ($LASTEXITCODE -ne 0) { throw "Desktop keyboard shortcut regression failed. Candidate: $staging" }
    node scripts/Test-Desktop-McpShortcuts.mjs $desktop 'artifacts/SharedTerminal-0.1.35-windows-x64/shared-terminal-desktop.exe'
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
    $shortcutEditor = Get-Content -LiteralPath $shortcutEditorEvidence -Raw | ConvertFrom-Json
    $shortcutSsh = Get-Content -LiteralPath "artifacts/windows-$version-shortcut-routes-ssh.json" -Raw | ConvertFrom-Json
    $shortcutUart = Get-Content -LiteralPath "artifacts/windows-$version-shortcut-routes-uart.json" -Raw | ConvertFrom-Json
    $shortcutManagement = Get-Content -LiteralPath 'artifacts/shortcut-management-software-result.json' -Raw | ConvertFrom-Json
    $desktopShortcuts = Get-Content -LiteralPath 'artifacts/desktop-shortcuts-software-result.json' -Raw | ConvertFrom-Json
    $mcpShortcuts = Get-Content -LiteralPath "artifacts/windows-$version-mcp-shortcuts-verification.json" -Raw | ConvertFrom-Json
    if ($verified.result -ne 'PASS' -or $mcp.result -ne 'PASS' -or $mcp.preview -ne $unpacked -or
        $local.result -ne 'PASS' -or $local.executable -ne $desktop -or $adb.result -ne 'PASS' -or $adb.executable -ne $desktop -or
        $powershell.result -ne 'PASS' -or $powershell.executable -ne $desktop -or
        $scripts.result -ne 'PASS' -or $scripts.executable -ne $desktop -or
        $directory.result -ne 'PASS' -or $directory.executable -ne $desktop -or
        $localTabs.result -ne 'PASS' -or $localTabs.executable -ne $desktop -or $localTabs.sha256 -ne $desktopHash -or
        !$localTabs.nativeMouse -or !$localTabs.nativeDoubleClick -or
        $mixedTabs.result -ne 'PASS' -or $mixedTabs.executable -ne $desktop -or $mixedTabs.desktopSha256 -ne $desktopHash -or
        $shortcutPreview.result -ne 'PASS' -or $shortcutPreview.executable -ne $desktop -or $shortcutPreview.sha256 -ne $desktopHash -or
        $shortcutEditor.result -ne 'PASS' -or $shortcutEditor.executable -ne $desktop -or $shortcutEditor.desktopSha256 -ne $desktopHash -or !$shortcutEditor.isolatedRootRemoved -or
        $shortcutSsh.result -ne 'PASS' -or $shortcutSsh.executable -ne $desktop -or $shortcutSsh.sha256 -ne $desktopHash -or
        $shortcutUart.result -ne 'PASS' -or $shortcutUart.executable -ne $uartDesktop -or $shortcutUart.sha256 -ne $desktopHash -or
        $shortcutManagement.result -ne 'PASS' -or $shortcutManagement.executable -ne $desktop -or
        $desktopShortcuts.result -ne 'PASS' -or $desktopShortcuts.executable -ne $desktop -or
        $mcpShortcuts.result -ne 'PASS' -or $mcpShortcuts.executable -ne $desktop -or $mcpShortcuts.desktopSha256 -ne $desktopHash) {
        throw 'Release evidence mismatch'
    }
    $featureReports = [ordered]@{}
    foreach ($gate in @(
        @{name='savedSsh';path=$savedSshEvidence;executable=$desktop},
        @{name='fileDrop';path=$fileDropEvidence;executable=$desktop},
        @{name='profileDeletion';path=$deletionEvidence;executable=$desktop},
        @{name='contextMenu';path=$contextMenuEvidence;executable=$desktop},
        @{name='serialConfig';path=$serialConfigEvidence;executable=$uartDesktop}
    )) {
        $result = Get-Content -LiteralPath $gate.path -Raw | ConvertFrom-Json
        if ($result.result -ne 'PASS' -or $result.executable -ne $gate.executable -or $result.desktopSha256 -ne $desktopHash) {
            throw "Release feature evidence mismatch: $($gate.name)"
        }
        $featureReports[$gate.name] = $result
    }
    if ($featureReports.fileDrop.source -ne 'Win32 OLE CF_HDROP fixture') {
        throw 'Release file-drop acceptance requires the Windows OLE source'
    }
    foreach ($gate in $newGates) {
        $result = Get-Content -LiteralPath (Join-Path $staging $gate.file) -Raw | ConvertFrom-Json
        if ($result.result -ne 'PASS' -or $result.executable -ne $desktop -or $result.desktopSha256 -ne $desktopHash) {
            throw "Release feature evidence mismatch: $($gate.name)"
        }
        $featureReports[$gate.name] = $result
    }
    if (!$featureReports.shortcutPackage.nativePicker) { throw 'Release shortcut package gate requires native pickers' }
    $report = [ordered]@{result='PASS';version=$version;sourceCommit=$commit;directoryOnly=[bool]$DirectoryOnly;zipSha256=$sha256;smoke=$verified;terminalRead=$mcp.read;terminalReadClose=$mcp.close;localTerminal=$local;adbShortcuts=$adb;powerShell=$powershell;localScripts=$scripts;localDirectory=$directory;localTabs=$localTabs;mixedTabs=$mixedTabs;shortcutPreview=$shortcutPreview;shortcutEditor=$shortcutEditor;shortcutSsh=$shortcutSsh;shortcutUart=$shortcutUart;shortcutManagement=$shortcutManagement;desktopShortcuts=$desktopShortcuts;mcpShortcuts=$mcpShortcuts;features=$featureReports}
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
