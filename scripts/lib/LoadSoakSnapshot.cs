using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class LoadSoakSnapshot
{
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Entry
    {
        public uint Size, Usage, Pid;
        public UIntPtr Heap;
        public uint Module, Threads, Parent;
        public int Priority;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string Name;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct MemoryStatus
    {
        public uint Length, Load;
        public ulong Total, Available, TotalPage, AvailablePage, TotalVirtual, AvailableVirtual, Extended;
    }
    [StructLayout(LayoutKind.Sequential)]
    private struct PerformanceInformation
    {
        public uint Size;
        public UIntPtr CommitTotal, CommitLimit, CommitPeak, PhysicalTotal, PhysicalAvailable,
            SystemCache, KernelTotal, KernelPaged, KernelNonpaged, PageSize;
        public uint HandleCount, ProcessCount, ThreadCount;
    }
    public sealed class ProcessRow
    {
        public uint Pid, Parent;
        public string Name;
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr snapshot, ref Entry entry);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GlobalMemoryStatusEx(ref MemoryStatus status);
    [DllImport("kernel32.dll", EntryPoint = "K32GetPerformanceInfo")]
    private static extern bool GetPerformanceInfo(out PerformanceInformation info, uint size);

    public static ulong[] SystemCommit()
    {
        if (!GetPerformanceInfo(out var info, (uint)Marshal.SizeOf<PerformanceInformation>()))
            return null;
        var pageSize = info.PageSize.ToUInt64();
        return new[] { info.CommitTotal.ToUInt64() * pageSize, info.CommitLimit.ToUInt64() * pageSize };
    }
    public static ulong[] Memory()
    {
        var status = new MemoryStatus { Length = (uint)Marshal.SizeOf<MemoryStatus>() };
        if (!GlobalMemoryStatusEx(ref status)) throw new Win32Exception();
        return new[] { status.Total, status.Available };
    }
    public static ProcessRow[] Processes()
    {
        var handle = CreateToolhelp32Snapshot(2, 0);
        if (handle == new IntPtr(-1)) throw new Win32Exception();
        try
        {
            var rows = new List<ProcessRow>();
            var entry = new Entry { Size = (uint)Marshal.SizeOf<Entry>() };
            if (!Process32FirstW(handle, ref entry)) throw new Win32Exception();
            do
            {
                rows.Add(new ProcessRow { Pid = entry.Pid, Parent = entry.Parent, Name = entry.Name });
            } while (Process32NextW(handle, ref entry));
            if (Marshal.GetLastWin32Error() != 18) throw new Win32Exception();
            return rows.ToArray();
        }
        finally { CloseHandle(handle); }
    }
}
