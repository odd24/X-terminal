param(
    [string[]]$PendingStep = @()
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$issues = [System.Collections.Generic.List[string]]::new()
$markdownFiles = @(Get-ChildItem -LiteralPath $repoRoot -Filter '*.md' -File)
$markdownFiles += @(Get-ChildItem -LiteralPath (Join-Path $repoRoot 'docs') -Filter '*.md' -File -Recurse)

# Only local Markdown file links are checked, not external URLs or heading anchors.
foreach ($file in $markdownFiles) {
    $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding utf8
    foreach ($link in [regex]::Matches($content, '\[[^\]]*\]\(([^)]+)\)')) {
        $target = $link.Groups[1].Value.Trim()
        if ($target -match '^(https?://|mailto:|#)') { continue }
        $target = ($target -split '#', 2)[0]
        if ($target -and -not (Test-Path -LiteralPath (Join-Path $file.DirectoryName $target))) {
            $issues.Add("Broken link: $($file.Name) -> $target")
        }
    }
}

$plan = Get-Content -LiteralPath (Join-Path $repoRoot 'docs/EXECUTION_PLAN.md') -Raw -Encoding utf8
$ledger = Get-Content -LiteralPath (Join-Path $repoRoot 'docs/EXECUTION_LOG.md') -Raw -Encoding utf8
$planIds = @([regex]::Matches($plan, '(?m)^### (P\d{2}(?:\.\d+)?)\s') | ForEach-Object { $_.Groups[1].Value })
$rows = @([regex]::Matches($ledger, '(?m)^\| ((?:P|D)\d{2}(?:\.\d+)?) \| ([^|]+) \| ([A-Z_]+) \|'))
$ledgerIds = @($rows | ForEach-Object { $_.Groups[1].Value })
foreach ($group in ($planIds | Group-Object)) {
    if ($group.Count -ne 1) { $issues.Add("Duplicate plan step: $($group.Name)") }
}
foreach ($group in ($ledgerIds | Group-Object)) {
    if ($group.Count -ne 1) { $issues.Add("Duplicate ledger step: $($group.Name)") }
}
foreach ($id in $planIds) {
    if ($id -notin $ledgerIds) { $issues.Add("Missing ledger step: $id") }
}
foreach ($id in $ledgerIds) {
    if ($id.StartsWith('P') -and $id -notin $planIds) { $issues.Add("Missing plan step: $id") }
}
foreach ($id in $PendingStep) {
    if ($id -notin $ledgerIds) { $issues.Add("Unknown pending step: $id") }
}
foreach ($row in $rows) {
    $id = $row.Groups[1].Value
    $state = $row.Groups[3].Value
    if ($state -notin @('TODO','IN_PROGRESS','BLOCKED','DONE','REVERTED','CANCELLED')) {
        $issues.Add("Invalid state: $id $state")
    }
    if ($state -eq 'DONE') {
        if (-not (Test-Path -LiteralPath (Join-Path $repoRoot "docs/records/$id.md"))) {
            $issues.Add("Missing completed record: $id")
        }
        if ($id -notin $PendingStep) {
            $history = & git -C $repoRoot log --all --format=%H --fixed-strings "--grep=Step-ID: $id"
            if ($LASTEXITCODE -ne 0) { $issues.Add("Git query failed: $id"); continue }
            $found = $false
            foreach ($hash in $history) {
                $body = & git -C $repoRoot show -s --format=%B $hash
                if ($body -contains "Step-ID: $id") { $found = $true; break }
            }
            if (-not $found) { $issues.Add("Missing exact commit trailer: Step-ID: $id") }
        }
    }
}

if ($issues.Count -gt 0) {
    $issues | ForEach-Object { Write-Output "ERROR: $_" }
    exit 1
}
Write-Output "PASS: $($markdownFiles.Count) Markdown files, $($planIds.Count) implementation steps, $($rows.Count) ledger rows."
if ($PendingStep.Count -gt 0) {
    Write-Output "Pre-commit history exemption: $($PendingStep -join ', '); rerun without exemption after commit."
}
