param(
    [Parameter(Mandatory)][int]$TargetProcessId,
    [Parameter(Mandatory)][string]$ExpectedExecutable,
    [Parameter(Mandatory)][int]$X,
    [Parameter(Mandatory)][int]$Y,
    [Parameter(Mandatory)][string]$PathList,
    [switch]$Cancel
)

$ErrorActionPreference = 'Stop'
$process = Get-Process -Id $TargetProcessId
if ($process.Path -ine (Resolve-Path -LiteralPath $ExpectedExecutable).Path -or !$process.MainWindowHandle) {
    throw 'The target is not the expected owned desktop window.'
}
[string[]]$files = Get-Content -Raw -Encoding UTF8 -LiteralPath $PathList | ConvertFrom-Json
foreach ($file in $files) {
    if (![IO.Path]::IsPathRooted($file) -or !(Test-Path -LiteralPath $file)) {
        throw "Missing owned file-drop fixture: $file"
    }
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
using IDataObject = System.Runtime.InteropServices.ComTypes.IDataObject;

[ComVisible(true), Guid("00000121-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IFileTestDropSource {
    [PreserveSig] int QueryContinueDrag(bool escape, uint keys);
    [PreserveSig] int GiveFeedback(uint effect);
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class FileTestDrop : IFileTestDropSource {
    [StructLayout(LayoutKind.Sequential)] struct Point { public int x, y; }
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr window, IntPtr order, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, uint x, uint y, uint data, UIntPtr extra);
    [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("ole32.dll")] static extern int OleInitialize(IntPtr reserved);
    [DllImport("ole32.dll")] static extern void OleUninitialize();
    [DllImport("ole32.dll")] static extern int DoDragDrop(IDataObject data, IFileTestDropSource source,
        uint allowed, out uint effect);

    const int Drop = 0x00040100;
    const int Cancel = 0x00040101;
    readonly IntPtr window;
    readonly IntPtr source;
    readonly bool cancel;
    string decision;
    readonly Stopwatch elapsed = Stopwatch.StartNew();

    FileTestDrop(IntPtr window, IntPtr source, bool cancel) { this.window = window; this.source = source; this.cancel = cancel; }
    static bool Owned(IntPtr window, Point point) {
        return GetAncestor(WindowFromPoint(point), 2) == window;
    }
    public int QueryContinueDrag(bool escape, uint keys) {
        Point point;
        if (escape || !GetCursorPos(out point)) { decision = "escape or cursor unavailable"; return Cancel; }
        if ((keys & 1) != 0 || elapsed.ElapsedMilliseconds < 700) {
            if (Owned(window, point) || Owned(source, point)) return 0;
            decision = "pointer left both owned windows while pressed";
            return Cancel;
        }
        decision = "released after " + elapsed.ElapsedMilliseconds + " ms; keys " + keys +
            "; owned destination " + Owned(window, point);
        return elapsed.ElapsedMilliseconds >= 700 && Owned(window, point) && !cancel ? Drop : Cancel;
    }
    public int GiveFeedback(uint effect) { return 0x00040102; }

    public static string Run(IntPtr window, int x, int y, string[] files, bool cancel) {
        IntPtr dpi = SetThreadDpiAwarenessContext(new IntPtr(-4));
        Point point = new Point {x = x, y = y};
        if (!ClientToScreen(window, ref point)) throw new Exception("Cannot map owned client point.");
        if (!Owned(window, point)) {
            var workArea = Screen.FromHandle(window).WorkingArea;
            if (!SetWindowPos(window, new IntPtr(-1), workArea.Left + 48, workArea.Top + 32, 0, 0, 0x51))
                throw new Exception("Cannot position the owned test window.");
            Thread.Sleep(150);
            point = new Point {x = x, y = y};
            if (!ClientToScreen(window, ref point) || !Owned(window, point))
                throw new Exception("The drop point (" + point.x + "," + point.y + ") is outside the visible owned test window. Work area: " + workArea);
        }
        Point previous;
        if (!GetCursorPos(out previous)) throw new Exception("Cannot read cursor position.");
        int ole = OleInitialize(IntPtr.Zero);
        if (ole < 0) Marshal.ThrowExceptionForHR(ole);
        using (var halt = new ManualResetEvent(false))
        using (var source = new Form()) {
            source.FormBorderStyle = FormBorderStyle.FixedToolWindow;
            source.StartPosition = FormStartPosition.Manual;
            var area = Screen.FromHandle(window).WorkingArea;
            source.SetBounds(area.Left + 5, area.Top + 5, 124, 60);
            source.ShowInTaskbar = false;
            source.TopMost = true;
            source.Text = "OLE file fixture";
            source.Show();
            IntPtr sourceWindow = source.Handle;
            var start = new Point { x = area.Left + 40, y = area.Top + 40 };
            Thread mover = new Thread(() => {
                SetThreadDpiAwarenessContext(new IntPtr(-4));
                int shift = 1;
                if (halt.WaitOne(150)) return;
                Stopwatch active = Stopwatch.StartNew();
                while (!halt.WaitOne(40)) {
                    Point next = new Point {x = point.x + shift, y = point.y};
                    if (!Owned(window, next) || active.ElapsedMilliseconds >= 770) {
                        mouse_event(4, 0, 0, 0, UIntPtr.Zero);
                        return;
                    }
                    SetCursorPos(next.x, next.y);
                    shift = 1 - shift;
                }
            });
            bool pressed = false;
            try {
                if (!Owned(sourceWindow, start) || !Owned(window, point)) throw new Exception("OLE fixture ownership check failed.");
                if (GetAsyncKeyState(1) < 0) throw new Exception("The left button is already pressed.");
                SetCursorPos(start.x, start.y);
                mouse_event(2, 0, 0, 0, UIntPtr.Zero);
                pressed = true;
                Thread.Sleep(60);
                if (GetAsyncKeyState(1) >= 0) throw new Exception("The owned fixture could not acquire the synthetic left button.");
                var data = new DataObject();
                data.SetData(DataFormats.FileDrop, true, files);
                mover.Start();
                uint effect;
                var drag = new FileTestDrop(window, sourceWindow, cancel);
                int result = DoDragDrop((IDataObject)data, drag, 1, out effect);
                if (result < 0) Marshal.ThrowExceptionForHR(result);
                if (result != (cancel ? Cancel : Drop)) throw new Exception("OLE drag ended early: " + drag.decision);
                return result.ToString("X") + "/" + effect;
            } finally {
                halt.Set();
                if (mover.IsAlive) mover.Join();
                if (pressed && GetAsyncKeyState(1) < 0) mouse_event(4, 0, 0, 0, UIntPtr.Zero);
                SetCursorPos(previous.x, previous.y);
                SetWindowPos(window, new IntPtr(-2), 0, 0, 0, 0, 0x13);
                OleUninitialize();
                if (dpi != IntPtr.Zero) SetThreadDpiAwarenessContext(dpi);
            }
        }
    }
}
'@

[FileTestDrop]::Run($process.MainWindowHandle, $X, $Y, $files, $Cancel.IsPresent)
