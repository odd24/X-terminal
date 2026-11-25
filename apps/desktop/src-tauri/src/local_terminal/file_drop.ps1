& {
    try {
        $compatibility = $false
        $expectedAssembly = $env:SHARED_TERMINAL_PSREADLINE_ASSEMBLY
        if ($expectedAssembly) {
            try {
                if (!(Get-Module PSReadLine)) { Import-Module PSReadLine -ErrorAction Stop }
                $compatibility = [Microsoft.PowerShell.PSConsoleReadLine].Assembly.Location -ieq $expectedAssembly
            } finally {
                $env:PSModulePath = $env:SHARED_TERMINAL_ORIGINAL_PS_MODULE_PATH
                Remove-Item Env:SHARED_TERMINAL_PSREADLINE_ASSEMBLY, Env:SHARED_TERMINAL_ORIGINAL_PS_MODULE_PATH -ErrorAction SilentlyContinue
            }
        }
        if (__ISOLATED__) {
            if (!(Get-Module PSReadLine)) { Import-Module PSReadLine -ErrorAction Stop }
            Set-PSReadLineOption -HistorySaveStyle SaveNothing
            [Console]::WriteLine('SHARED_TERMINAL_ISOLATED_POWERSHELL_READY')
        }
        $editor = Get-Command PSConsoleHostReadLine -CommandType Function -ListImported -ErrorAction SilentlyContinue
        if ($compatibility -and (!$editor -or $editor.ModuleName -eq 'PSReadLine')) {
            $readLine = { [Microsoft.PowerShell.PSConsoleReadLine]::ReadLine($Host.Runspace, $ExecutionContext) }
            # Even if the drop channel cannot start, this binary module needs
            # its normal ConsoleHost entry point.
            Set-Item Function:global:PSConsoleHostReadLine -Value $readLine
        } else {
            if (!$editor) {
                Import-Module PSReadLine -ErrorAction Stop
                $editor = Get-Command PSConsoleHostReadLine -CommandType Function -ErrorAction Stop
            }
            if ($editor.ModuleName -ne 'PSReadLine') { return }
            $readLine = $editor.ScriptBlock
        }

        $name = 'SharedTerminalDrop.__TASK__'
        $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
        $mapSecurity = [System.IO.MemoryMappedFiles.MemoryMappedFileSecurity]::new()
        $mapSecurity.SetAccessRuleProtection($true, $false)
        $mapSecurity.AddAccessRule([System.Security.AccessControl.AccessRule[System.IO.MemoryMappedFiles.MemoryMappedFileRights]]::new(
            $sid, 'FullControl', 'Allow'))
        $mapping = [System.IO.MemoryMappedFiles.MemoryMappedFile]::CreateNew(
            "Local\$name", 4, 'ReadWrite', 'None', $mapSecurity, 'None')
        $pipeSecurity = [System.IO.Pipes.PipeSecurity]::new()
        $pipeSecurity.SetAccessRuleProtection($true, $false)
        $pipeSecurity.AddAccessRule([System.IO.Pipes.PipeAccessRule]::new($sid, 'FullControl', 'Allow'))
        $state = @{
            name = $name
            mapping = $mapping
            stamp = $mapping.CreateViewAccessor()
            pipeSecurity = $pipeSecurity
            timer = [System.Timers.Timer]::new(120)
            editor = $readLine
            generation = [uint32]0
            buffer = [byte[]]::new(16384)
            used = 0
            pipe = $null
            accept = $null
            read = $null
            replied = $false
        }
        $null = Register-ObjectEvent $state.timer Elapsed -SourceIdentifier $name -MessageData $state -Action {
            $drop = $Event.MessageData
            if ($null -eq $drop.pipe) { return }
            try {
                if ($drop.accept) {
                    if (!$drop.accept.IsCompleted) { return }
                    $drop.pipe.EndWaitForConnection($drop.accept)
                    $drop.accept = $null
                    $drop.read = $drop.pipe.ReadAsync($drop.buffer, 0, $drop.buffer.Length)
                }
                if (!$drop.read.IsCompleted) { return }
                $count = $drop.read.GetAwaiter().GetResult()
                if ($count -gt 0 -and !$drop.replied) {
                    $drop.used += $count
                    if ($drop.buffer[$drop.used - 1] -ne 10 -and $drop.used -lt $drop.buffer.Length) {
                        $drop.read = $drop.pipe.ReadAsync($drop.buffer, $drop.used, $drop.buffer.Length - $drop.used)
                        return
                    }
                    $request = [System.Text.Encoding]::UTF8.GetString($drop.buffer, 0, $drop.used) | ConvertFrom-Json
                    $accepted = $false
                    if ($request.generation -eq $drop.generation -and
                        [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $request.expiry) {
                        $draft = ''; $cursor = 0
                        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$draft, [ref]$cursor)
                        $left = $draft.Substring(0, $cursor)
                        $right = $draft.Substring($cursor)
                        $quoted = @($request.paths | ForEach-Object { "'" + ($_ -replace "['‘’‚‛]", '$0$0') + "'" })
                        $prefix = if ($left.Length -and ![char]::IsWhiteSpace($left[$left.Length - 1])) { ' ' } else { '' }
                        $suffix = if ($right.Length -and ![char]::IsWhiteSpace($right[0])) { ' ' } else { '' }
                        $insert = $prefix + ($quoted -join ' ') + $suffix
                        $tokens = $null; $parseErrors = $null
                        $syntax = [System.Management.Automation.Language.Parser]::ParseInput(
                            $left + $insert + $right, [ref]$tokens, [ref]$parseErrors)
                        # A token parsed inside a quote, comment, here-string or stop-parsing
                        # region cannot match its proposed offset and literal value here.
                        $offset = $cursor + $prefix.Length
                        $accepted = $quoted.Count -gt 0
                        for ($i = 0; $accepted -and $i -lt $quoted.Count; $i++) {
                            $token = $tokens.Where({ $_.Extent.StartOffset -eq $offset }, 'First')
                            $accepted = $token.Count -eq 1 -and $token[0].Kind -eq 'StringLiteral' -and
                                $token[0].Extent.Text -ceq $quoted[$i] -and $token[0].Value -ceq $request.paths[$i]
                            if ($accepted) {
                                $command = $syntax.Find({
                                    param($node)
                                    $node -is [System.Management.Automation.Language.CommandAst] -and
                                        $node.CommandElements[0].Extent.StartOffset -eq $offset
                                }, $true)
                                $accepted = $null -eq $command
                            }
                            $offset += $quoted[$i].Length + 1
                        }
                        $accepted = $accepted -and $request.generation -eq $drop.generation -and
                            [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -lt $request.expiry
                        if ($accepted) { [Microsoft.PowerShell.PSConsoleReadLine]::Insert($insert) }
                    }
                    $drop.pipe.WriteByte([byte]$accepted)
                    # Wait asynchronously for the client to read the receipt and close.
                    # Disconnecting immediately can discard unread bytes.
                    $drop.replied = $true
                    $drop.read = $drop.pipe.ReadAsync($drop.buffer, 0, 1)
                    return
                }
            } catch {
                # Dropped connections and malformed requests leave the current line intact.
            }
            try {
                $drop.used = 0
                $drop.read = $null
                $drop.replied = $false
                $drop.pipe.Disconnect()
                $drop.accept = $drop.pipe.BeginWaitForConnection($null, $null)
            } catch {
                $drop.stamp.Write(0, [uint32]0)
                $drop.pipe.Dispose()
                $drop.pipe = $null
            }
        }
        $global:__SharedTerminalFileDrop = $state
        function global:PSConsoleHostReadLine {
            $drop = $global:__SharedTerminalFileDrop
            if ($NestedPromptLevel -gt 0) { & $drop.editor; return }
            try {
                $drop.generation++
                $drop.used = 0
                $drop.read = $null
                $drop.replied = $false
                $drop.pipe = [System.IO.Pipes.NamedPipeServerStream]::new(
                    $drop.name, 'InOut', 1, 'Byte', 'Asynchronous', 16384, 1, $drop.pipeSecurity)
                $drop.accept = $drop.pipe.BeginWaitForConnection($null, $null)
                $drop.stamp.Write(0, [uint32]$drop.generation)
                $drop.timer.Start()
            } catch {}
            try {
                & $drop.editor
            } finally {
                $drop.stamp.Write(0, [uint32]0)
                $drop.timer.Stop()
                if ($drop.pipe) { $drop.pipe.Dispose(); $drop.pipe = $null }
            }
        }
    } catch {
        # An unavailable editor or integration leaves ordinary PowerShell input usable.
    }
}
