using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Vitals;

internal static class Native
{
    // ---- memory ----
    [StructLayout(LayoutKind.Sequential)]
    public struct MEMORYSTATUSEX
    {
        public uint dwLength, dwMemoryLoad;
        public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile, ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX status);

    // ---- windows ----
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT pt);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT pt);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
    public const uint GA_ROOT = 2, GW_HWNDPREV = 3;
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromPoint(POINT pt, uint flags);
    [DllImport("shcore.dll")] public static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
    [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr hIcon);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    public const uint SWP_NOSIZE = 0x1, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
    [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] public static extern IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);
    public const int GWL_EXSTYLE = -20;
    public const long WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;

    [DllImport("dwmapi.dll")] public static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);
    public const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20, DWMWA_WINDOW_CORNER_PREFERENCE = 33;

    public static uint DpiForPoint(int x, int y)
    {
        var mon = MonitorFromPoint(new POINT { X = x, Y = y }, 2 /* nearest */);
        return GetDpiForMonitor(mon, 0, out var dx, out _) == 0 ? dx : 96;
    }

    public static void UseDarkTitleBar(IntPtr hwnd)
    {
        int on = 1;
        DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref on, sizeof(int));
    }

    // ---- events other processes can signal ----
    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string sddl, uint revision, out IntPtr sd, IntPtr size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern Microsoft.Win32.SafeHandles.SafeWaitHandle CreateEventW(ref SECURITY_ATTRIBUTES sa, bool manualReset, bool initialState, string name);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr mem);

    /// <summary>
    /// A named auto-reset event that this user's non-admin processes may signal even when Vitals runs as administrator.
    /// An event made the ordinary way by an admin process only lets admin processes open it.
    /// </summary>
    public static System.Threading.EventWaitHandle CreateUserSignalEvent(string name)
    {
        using var me = System.Security.Principal.WindowsIdentity.GetCurrent();
        // SYSTEM and Administrators get everything; this user may wait on it and set it (SYNCHRONIZE | EVENT_MODIFY_STATE);
        // the medium integrity label lets a non-admin process write to it.
        string sddl = $"D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;0x100002;;;{me.User!.Value})S:(ML;;NW;;;ME)";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out var sd, IntPtr.Zero))
            throw new System.ComponentModel.Win32Exception();
        try
        {
            var sa = new SECURITY_ATTRIBUTES { nLength = Marshal.SizeOf<SECURITY_ATTRIBUTES>(), lpSecurityDescriptor = sd };
            var handle = CreateEventW(ref sa, false, false, name);
            if (handle.IsInvalid) throw new System.ComponentModel.Win32Exception();
            return new System.Threading.EventWaitHandle(false, System.Threading.EventResetMode.AutoReset) { SafeWaitHandle = handle };
        }
        finally { LocalFree(sd); }
    }
}

/// <summary>NVIDIA's management library, which ships with the NVIDIA driver (System32\nvml.dll).</summary>
internal static class Nvml
{
    private const string Dll = "nvml.dll";

    [StructLayout(LayoutKind.Sequential)] public struct Utilization { public uint Gpu, Memory; }
    [StructLayout(LayoutKind.Sequential)] public struct Memory { public ulong Total, Free, Used; }

    [DllImport(Dll)] public static extern int nvmlInit_v2();
    [DllImport(Dll)] public static extern int nvmlShutdown();
    [DllImport(Dll)] public static extern int nvmlDeviceGetHandleByIndex_v2(uint index, out IntPtr device);
    [DllImport(Dll)] private static extern int nvmlDeviceGetName(IntPtr device, byte[] name, uint length);
    [DllImport(Dll)] public static extern int nvmlDeviceGetUtilizationRates(IntPtr device, out Utilization util);
    [DllImport(Dll)] public static extern int nvmlDeviceGetTemperature(IntPtr device, int sensor, out uint temp);
    [DllImport(Dll)] public static extern int nvmlDeviceGetMemoryInfo(IntPtr device, out Memory mem);
    [DllImport(Dll)] public static extern int nvmlDeviceGetTemperatureThreshold(IntPtr device, int type, out uint temp);

    public const int TEMPERATURE_GPU = 0, THRESHOLD_SLOWDOWN = 1;

    public static string? GetName(IntPtr device)
    {
        var buf = new byte[96];
        if (nvmlDeviceGetName(device, buf, (uint)buf.Length) != 0) return null;
        int n = Array.IndexOf(buf, (byte)0);
        return Encoding.ASCII.GetString(buf, 0, n < 0 ? buf.Length : n).Trim();
    }
}

/// <summary>Windows performance counters through PDH, read straight so a wildcard counter costs one call.</summary>
internal sealed class PdhCounter : IDisposable
{
    [StructLayout(LayoutKind.Explicit)]
    private struct FmtValue
    {
        [FieldOffset(0)] public uint CStatus;
        [FieldOffset(8)] public double Double;
        [FieldOffset(8)] public long Large;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FmtItem { public IntPtr Name; public FmtValue Value; }

    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhOpenQuery(string? source, IntPtr user, out IntPtr query);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr user, out IntPtr counter);
    [DllImport("pdh.dll")] private static extern uint PdhCollectQueryData(IntPtr query);
    [DllImport("pdh.dll")] private static extern uint PdhGetFormattedCounterValue(IntPtr counter, uint format, out uint type, out FmtValue value);
    [DllImport("pdh.dll", CharSet = CharSet.Unicode)] private static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint size, out uint count, IntPtr buffer);
    [DllImport("pdh.dll")] private static extern uint PdhCloseQuery(IntPtr query);

    private const uint FMT_DOUBLE = 0x200, FMT_LARGE = 0x400, FMT_NOCAP100 = 0x8000, MORE_DATA = 0x800007D2;

    private readonly IntPtr _query;
    private readonly IntPtr[] _counters;
    public bool Ok { get; }

    /// <param name="paths">One or more counters, collected together in one query so their values come from the
    /// same moment. Read each by its position with <see cref="ReadLargeArray"/>.</param>
    public PdhCounter(params string[] paths)
    {
        _counters = new IntPtr[paths.Length];
        Ok = paths.Length > 0 && PdhOpenQuery(null, IntPtr.Zero, out _query) == 0;
        for (int i = 0; Ok && i < paths.Length; i++)
            Ok = PdhAddEnglishCounter(_query, paths[i], IntPtr.Zero, out _counters[i]) == 0;
    }

    public bool Collect() => Ok && PdhCollectQueryData(_query) == 0;

    /// <param name="index">Which of the query's counters to read, in the order they were given.</param>
    public double? ReadDouble(int index = 0)
    {
        if (!Ok || index < 0 || index >= _counters.Length ||
            PdhGetFormattedCounterValue(_counters[index], FMT_DOUBLE | FMT_NOCAP100, out _, out var v) != 0 || v.CStatus > 1) return null;
        return v.Double;
    }

    /// <summary>Every instance of a wildcard counter, as (instance name, value).</summary>
    /// <param name="index">Which of the query's counters to read, in the order they were given.</param>
    public (string Name, long Value)[] ReadLargeArray(int index = 0) =>
        ReadArray(index, FMT_LARGE, v => v.Large);

    /// <summary>Every instance of a wildcard rate counter (such as a % counter), as (instance name, value), uncapped
    /// so a process busy on several cores reads over 100. Needs two <see cref="Collect"/> calls; until then, and for
    /// an instance that appeared since the last one, the value is 0.</summary>
    public (string Name, double Value)[] ReadDoubleArray(int index = 0) =>
        ReadArray(index, FMT_DOUBLE | FMT_NOCAP100, v => v.Double);

    private (string Name, T Value)[] ReadArray<T>(int index, uint format, Func<FmtValue, T> pick) where T : struct
    {
        if (!Ok || index < 0 || index >= _counters.Length) return Array.Empty<(string, T)>();
        IntPtr counter = _counters[index];
        uint size = 0;
        uint r = PdhGetFormattedCounterArray(counter, format, ref size, out uint count, IntPtr.Zero);
        if (r != MORE_DATA || size == 0) return Array.Empty<(string, T)>();
        IntPtr buf = Marshal.AllocHGlobal((int)size);
        try
        {
            if (PdhGetFormattedCounterArray(counter, format, ref size, out count, buf) != 0) return Array.Empty<(string, T)>();
            var result = new (string, T)[count];
            int stride = Marshal.SizeOf<FmtItem>();
            for (int i = 0; i < count; i++)
            {
                var item = Marshal.PtrToStructure<FmtItem>(buf + i * stride);
                result[i] = (Marshal.PtrToStringUni(item.Name) ?? "", item.Value.CStatus <= 1 ? pick(item.Value) : default);
            }
            return result;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    public void Dispose() { if (_query != IntPtr.Zero) PdhCloseQuery(_query); }
}
