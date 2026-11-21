param(
    [Parameter(Mandatory)][string]$Root,
    [Parameter(Mandatory)][string]$Filename,
    [switch]$Delete,
    [switch]$FindHolders
)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class OwnedLogSharing {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode)]
    static extern uint GetLongPathName(string path, StringBuilder result, uint size);
    public static string Expand(string path) {
        var result = new StringBuilder(32768);
        var count = GetLongPathName(path, result, (uint)result.Capacity);
        if (count == 0 || count >= result.Capacity) throw new InvalidOperationException("Path cannot be normalized.");
        return result.ToString();
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool MoveFile(string source, string target);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern bool DeleteFile(string source);
    public static int Rename(string source, string target) {
        return MoveFile(source, target) ? 0 : Marshal.GetLastWin32Error();
    }
    public static int Remove(string source) {
        return DeleteFile(source) ? 0 : Marshal.GetLastWin32Error();
    }
    [StructLayout(LayoutKind.Sequential)] struct ProcessKey {
        public uint Pid;
        public System.Runtime.InteropServices.ComTypes.FILETIME Started;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct ProcessInfo {
        public ProcessKey Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string Application;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string Service;
        public uint Type, Status, Session;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmStartSession(out uint session, int flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)]
    static extern int RmRegisterResources(uint session, uint count, string[] files, uint processes, IntPtr keys, uint services, IntPtr names);
    [DllImport("rstrtmgr.dll")]
    static extern int RmGetList(uint session, out uint needed, ref uint count, [In,Out] ProcessInfo[] processes, ref uint reasons);
    [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint session);
    public static uint[] Holders(string path) {
        Check(RmStartSession(out uint session, 0, new StringBuilder(33)));
        try {
            Check(RmRegisterResources(session, 1, new[]{path}, 0, IntPtr.Zero, 0, IntPtr.Zero));
            uint count = 0, reasons = 0;
            int code = RmGetList(session, out uint needed, ref count, null, ref reasons);
            if (code == 0) return Array.Empty<uint>();
            if (code != 234 || needed > 64) throw new InvalidOperationException("Unexpected Restart Manager result: " + code);
            var processes = new ProcessInfo[needed];
            count = needed;
            Check(RmGetList(session, out needed, ref count, processes, ref reasons));
            var ids = new uint[count];
            for (int i = 0; i < count; i++) ids[i] = processes[i].Process.Pid;
            return ids;
        } finally { RmEndSession(session); }
    }
    static void Check(int code) {
        if (code != 0) throw new InvalidOperationException("Restart Manager error: " + code);
    }
}
'@

$rootPath = [OwnedLogSharing]::Expand((Resolve-Path -LiteralPath $Root).Path)
$tempPath = [OwnedLogSharing]::Expand([IO.Path]::GetTempPath()).TrimEnd('\')
if ((Split-Path -Parent $rootPath) -ne $tempPath -or
    (Split-Path -Leaf $rootPath) -notmatch '^shared-terminal-(log-viewer|log-files)-ui-中文-' -or
    $Filename -ne [IO.Path]::GetFileName($Filename) -or
    $Filename -notmatch '^[^:]+\.log$') { throw 'Expected only an owned log-test file.' }
$folder = Join-Path $rootPath 'logs'
$source = Join-Path $folder $Filename
$moved = "$source.renamed"
$items = Get-Item -LiteralPath $rootPath,$folder,$source
if ($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }) { throw 'Reparse points are unsupported.' }
if (Test-Path -LiteralPath $moved) { throw 'Rename target already exists.' }
$holders = if ($FindHolders) { [OwnedLogSharing]::Holders($source) }
$rename = [OwnedLogSharing]::Rename($source, $moved)
if ($rename -eq 0) {
    $restored = [OwnedLogSharing]::Rename($moved, $source)
    if ($restored -ne 0) { throw "Could not restore owned log name: $restored" }
}
$removed = $null
if ($Delete) { $removed = [OwnedLogSharing]::Remove($source) }
@{rename=$rename; delete=$removed; holders=@($holders | Where-Object { $_ })} | ConvertTo-Json -Compress
