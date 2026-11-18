using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using LibreHardwareMonitor.Hardware;
using Microsoft.Win32;

namespace Vitals;

public sealed record Snapshot(
    double CpuLoad, double? CpuTemp,
    double? GpuLoad, double? GpuTemp,
    double RamUsedGB, double RamTotalGB,
    double? VramUsedGB, double? VramTotalGB);

/// <param name="Value">Percent of the whole CPU or GPU for the Cpu and Gpu lists, GB for Ram and Vram.</param>
public sealed record AppRow(string Name, double Value);
public sealed record AppUsage(AppRow[] Cpu, AppRow[] Gpu, AppRow[] Ram, AppRow[] Vram);

/// <summary>Reads CPU, GPU, RAM and VRAM. Not thread-safe: only the sampling thread calls it.</summary>
public sealed class HardwareSampler : IDisposable
{
    private readonly PdhCounter _cpuLoad = new(@"\Processor Information(_Total)\% Processor Utility");
    private Computer? _lhm;
    private IHardware? _lhmCpu;
    private IntPtr _gpu;
    private readonly bool _nvmlOk;

    public string CpuModel { get; }
    public string? GpuModel { get; }
    /// <summary>The CPU's TjMax, once LibreHardwareMonitor can read it.</summary>
    public int? CpuLimit { get; private set; }
    /// <summary>The GPU's slowdown temperature, from the NVIDIA driver.</summary>
    public int? GpuLimit { get; }
    public bool CpuTempAvailable { get; private set; }

    private int _emptyTempReads;
    private readonly long[] _partTicks = new long[4];
    private int _partCount;

    /// <summary>Average time per part of a reading so far, for the log.</summary>
    public string Timing()
    {
        if (_partCount == 0) return "";
        string Ms(int i) => (_partTicks[i] * 1000.0 / Stopwatch.Frequency / _partCount).ToString("0.0");
        return $"CPU load {Ms(0)} ms, CPU temp {Ms(1)} ms, GPU {Ms(2)} ms, RAM {Ms(3)} ms";
    }

    public HardwareSampler()
    {
        CpuModel = ReadCpuName();
        _cpuLoad.Collect(); // % Processor Utility needs two readings; this is the first.

        try
        {
            if (Nvml.nvmlInit_v2() == 0 && Nvml.nvmlDeviceGetHandleByIndex_v2(0, out _gpu) == 0)
            {
                _nvmlOk = true;
                GpuModel = Nvml.GetName(_gpu);
                if (Nvml.nvmlDeviceGetTemperatureThreshold(_gpu, Nvml.THRESHOLD_SLOWDOWN, out var slow) == 0 && slow > 0) GpuLimit = (int)slow;
            }
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            Log.Write("No NVIDIA driver library (nvml.dll); GPU readings are off.");
        }

        try
        {
            _lhm = new Computer { IsCpuEnabled = true };
            _lhm.Open();
            _lhmCpu = _lhm.Hardware.FirstOrDefault(h => h.HardwareType == HardwareType.Cpu);
        }
        catch (Exception ex)
        {
            Log.Write($"LibreHardwareMonitor didn't start; CPU temperature is off: {ex.Message}");
            _lhm = null;
        }
    }

    public Snapshot Sample()
    {
        long t0 = Stopwatch.GetTimestamp();
        _cpuLoad.Collect();
        double cpuLoad = Math.Clamp(_cpuLoad.ReadDouble() ?? 0, 0, 100);
        long t1 = Stopwatch.GetTimestamp();
        double? cpuTemp = ReadCpuTemp();
        long t2 = Stopwatch.GetTimestamp();

        double? gpuLoad = null, gpuTemp = null, vramUsed = null, vramTotal = null;
        if (_nvmlOk)
        {
            if (Nvml.nvmlDeviceGetUtilizationRates(_gpu, out var u) == 0) gpuLoad = u.Gpu;
            if (Nvml.nvmlDeviceGetTemperature(_gpu, Nvml.TEMPERATURE_GPU, out var t) == 0) gpuTemp = t;
            if (Nvml.nvmlDeviceGetMemoryInfo(_gpu, out var m) == 0) { vramUsed = m.Used / 1073741824.0; vramTotal = m.Total / 1073741824.0; }
        }

        long t3 = Stopwatch.GetTimestamp();
        var mem = new Native.MEMORYSTATUSEX { dwLength = (uint)System.Runtime.InteropServices.Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
        Native.GlobalMemoryStatusEx(ref mem);
        double ramTotal = mem.ullTotalPhys / 1073741824.0;
        double ramUsed = (mem.ullTotalPhys - mem.ullAvailPhys) / 1073741824.0;
        long t4 = Stopwatch.GetTimestamp();
        _partTicks[0] += t1 - t0; _partTicks[1] += t2 - t1; _partTicks[2] += t3 - t2; _partTicks[3] += t4 - t3; _partCount++;

        return new Snapshot(cpuLoad, cpuTemp, gpuLoad, gpuTemp, ramUsed, ramTotal, vramUsed, vramTotal);
    }

    private double? ReadCpuTemp()
    {
        if (_lhmCpu == null) return null;
        try
        {
            _lhmCpu.Update();
            var temps = _lhmCpu.Sensors.Where(s => s.SensorType == SensorType.Temperature && s.Value is > 0).ToList();
            if (CpuLimit == null)
            {
                // Intel reports each core's distance to TjMax; core temperature + distance = TjMax.
                var dist = temps.FirstOrDefault(s => s.Name.EndsWith("Distance to TjMax", StringComparison.Ordinal));
                var core = dist == null ? null : temps.FirstOrDefault(s => s.Name == dist.Name.Replace(" Distance to TjMax", ""));
                if (dist?.Value != null && core?.Value != null) CpuLimit = (int)Math.Round(core.Value.Value + dist.Value.Value);
            }
            ISensor? pick =
                temps.FirstOrDefault(s => s.Name == "CPU Package") ??
                temps.FirstOrDefault(s => s.Name.StartsWith("Core (Tctl", StringComparison.Ordinal)) ??
                temps.FirstOrDefault(s => s.Name == "Core Max");
            double? value = pick?.Value ?? temps.Where(s => s.Name.StartsWith("CPU Core #", StringComparison.Ordinal) && !s.Name.Contains("Distance"))
                                               .Select(s => (double?)s.Value).DefaultIfEmpty(null).Max();
            CpuTempAvailable = value != null;
            if (value == null && ++_emptyTempReads >= 3)
            {
                // Without the PawnIO driver (or without admin) there's never a reading, and each try costs ~60 ms.
                Log.Write("No CPU temperature (needs the PawnIO driver and admin). Stopped asking until Vitals restarts.");
                try { _lhm?.Close(); } catch { }
                _lhm = null;
                _lhmCpu = null;
            }
            return value;
        }
        catch { return null; }
    }

    private static string ReadCpuName()
    {
        try
        {
            using var key = Registry.LocalMachine.OpenSubKey(@"HARDWARE\DESCRIPTION\System\CentralProcessor\0");
            return (key?.GetValue("ProcessorNameString") as string)?.Trim() ?? "Unknown CPU";
        }
        catch { return "Unknown CPU"; }
    }

    public void Dispose()
    {
        _cpuLoad.Dispose();
        try { _lhm?.Close(); } catch { }
        if (_nvmlOk) try { Nvml.nvmlShutdown(); } catch { }
    }
}

/// <summary>CPU, GPU, RAM and VRAM per app, summed across each app's processes. Only read while the breakdown is showing.</summary>
public sealed class AppUsageSampler : IDisposable
{
    private readonly PdhCounter _ram = new(@"\Process(*)\Working Set - Private");
    // Read together so each process's two figures come from the same moment (see CapAtCommitted).
    private readonly PdhCounter _vram = new(@"\GPU Process Memory(*)\Dedicated Usage", @"\GPU Process Memory(*)\Total Committed");
    // Process V2 names instances "name:pid", so a rate is never worked out across two processes. The old Process set
    // names them "name#3", and those numbers shift when a process of the same name exits.
    private readonly PdhCounter _cpu = OpenCpu();
    private readonly PdhCounter _gpu = new(@"\GPU Engine(*)\Utilization Percentage");
    private readonly Dictionary<int, string> _names = new();
    private int _samples;
    private long _lastRateRead = long.MinValue / 2;

    /// <summary>A rate counter needs two readings. When the breakdown opens after a pause, the first is this long
    /// before the second, so the CPU and GPU lists fill before the panel shows (250 ms after the hover starts).</summary>
    private const int RateWarmUpMs = 200;

    private static PdhCounter OpenCpu()
    {
        var v2 = new PdhCounter(@"\Process V2(*)\% Processor Time");
        if (v2.Ok) return v2;
        v2.Dispose();
        return new PdhCounter(@"\Process(*)\% Processor Time");
    }

    /// <param name="vramUsedGB">VRAM in use on the card right now, from the driver.</param>
    /// <param name="vramTotalGB">The card's VRAM.</param>
    /// <remarks>Windows sometimes reports impossible per-app values: 952 GB for one app, and dwm.exe at 5.9 GB while
    /// the whole card used 2.7 GB. Each process's value is capped at what it has committed (see
    /// <see cref="CapAtCommitted"/>), and values no app could have (see <see cref="VramLimitBytes"/>) are dropped.</remarks>
    public AppUsage Sample(int top, double? vramUsedGB, double? vramTotalGB)
    {
        double? vramLimit = VramLimitBytes(vramUsedGB, vramTotalGB);
        if (++_samples % 120 == 0) _names.Clear();

        long now = Environment.TickCount64;
        bool cold = now - _lastRateRead > 3000;
        _lastRateRead = now;
        if (cold)
        {
            _cpu.Collect(); _gpu.Collect();
            Thread.Sleep(RateWarmUpMs);
        }

        var cpu = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        if (_cpu.Collect())
        {
            int cores = Math.Max(1, Environment.ProcessorCount);
            foreach (var (inst, value) in _cpu.ReadDoubleArray())
            {
                var name = CpuInstanceName(inst);
                if (name is "_Total" or "Idle" || value <= 0) continue;
                cpu[name] = cpu.GetValueOrDefault(name) + value / cores;
            }
        }

        // An app's GPU use is its busiest engine (3D, copy, video decode...), as in Task Manager: each engine's use
        // summed across the app's processes, then the highest.
        var gpuEngines = new Dictionary<(string App, string Engine), double>();
        if (_gpu.Collect())
            foreach (var (inst, value) in _gpu.ReadDoubleArray())
            {
                // "pid_1234_luid_0x00000000_0x0000F1A2_phys_0_eng_0_engtype_3D"
                if (value <= 0 || !TryPid(inst, out int pid, out int end)) continue;
                var name = NameOf(pid);
                if (name == null) continue;
                var key = (name, inst[end..]);
                gpuEngines[key] = gpuEngines.GetValueOrDefault(key) + value;
            }
        var gpu = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        foreach (var ((app, _), value) in gpuEngines) gpu[app] = Math.Max(gpu.GetValueOrDefault(app), value);

        var ram = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        if (_ram.Collect())
            foreach (var (inst, value) in _ram.ReadLargeArray())
            {
                if (inst is "_Total" or "Idle") continue;
                int hash = inst.IndexOf('#');
                var name = hash > 0 ? inst[..hash] : inst;
                ram[name] = ram.GetValueOrDefault(name) + value;
            }

        var vram = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        if (_vram.Collect())
        {
            var committed = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (var (inst, value) in _vram.ReadLargeArray(1)) committed[inst] = value;
            foreach (var (inst, dedicated) in _vram.ReadLargeArray(0))
            {
                // "pid_1234_luid_0x00000000_0x0001089C_phys_0"
                long value = CapAtCommitted(dedicated, committed.TryGetValue(inst, out long c) ? c : null);
                if (value <= 0 || !inst.StartsWith("pid_", StringComparison.Ordinal)) continue;
                if (vramLimit is double cap && value > cap) continue;
                if (!TryPid(inst, out int pid, out _)) continue;
                var name = NameOf(pid);
                if (name == null) continue;
                vram[name] = vram.GetValueOrDefault(name) + value;
            }
        }
        // An app's processes can each pass the check above yet add up to more than the card uses.
        if (vramLimit is double limit)
            foreach (var name in vram.Where(kv => kv.Value > limit).Select(kv => kv.Key).ToList()) vram.Remove(name);

        return new AppUsage(
            Top(cpu, top, v => Math.Min(100, v)),
            Top(gpu, top, v => Math.Min(100, v)),
            Top(ram, top, v => v / 1073741824.0),
            Top(vram, top, v => v / 1073741824.0));
    }

    /// <summary>The app name in a Process V2 instance ("chrome:1234") or a Process one ("chrome#3").</summary>
    internal static string CpuInstanceName(string inst)
    {
        int cut = inst.LastIndexOf(':');
        if (cut < 0) cut = inst.IndexOf('#');
        return cut > 0 ? inst[..cut] : inst;
    }

    /// <summary>The process id in a GPU counter instance ("pid_1234_luid_..."), and where the text after it starts.</summary>
    private static bool TryPid(string inst, out int pid, out int end)
    {
        pid = 0;
        end = inst.StartsWith("pid_", StringComparison.Ordinal) ? inst.IndexOf('_', 4) : -1;
        return end > 4 && int.TryParse(inst.AsSpan(4, end - 4), out pid);
    }

    /// <summary>A process's VRAM, in bytes: its Dedicated Usage, but never more than its Total Committed, since a
    /// process can't have more on the card than it has allocated. Windows broke that for dwm.exe on 16 Nov 2026
    /// (11.7 GB dedicated, 0.81 GB committed, while another app really held 14.6 of the card's 15.5 GB in use);
    /// every other process stayed at or under its committed figure, so they keep matching Task Manager.
    /// <paramref name="committed"/> is null when Windows gave no committed figure for that process; 0 counts as no
    /// figure too, because <see cref="PdhCounter.ReadLargeArray"/> reads a failed value as 0.</summary>
    internal static long CapAtCommitted(long dedicated, long? committed) =>
        committed is long c && c > 0 && dedicated > c ? c : dedicated;

    /// <summary>The most VRAM one app can really hold, in bytes: what the whole card uses now, plus 10% because the
    /// driver and Windows' counter are read a moment apart. The card's size when the driver gives no figure.</summary>
    internal static double? VramLimitBytes(double? usedGB, double? totalGB)
    {
        if (usedGB is double used && used > 0) return used * 1.1 * 1073741824.0;
        if (totalGB is double total && total > 0) return total * 1073741824.0;
        return null;
    }

    private static AppRow[] Top<T>(Dictionary<string, T> d, int n, Func<T, double> value) where T : IComparable<T> =>
        d.OrderByDescending(kv => kv.Value).Take(n).Select(kv => new AppRow(kv.Key + ".exe", value(kv.Value))).ToArray();

    private string? NameOf(int pid)
    {
        if (_names.TryGetValue(pid, out var n)) return n;
        try { using var p = Process.GetProcessById(pid); n = p.ProcessName; }
        catch { n = null; }
        if (n != null) _names[pid] = n;
        return n;
    }

    public void Dispose() { _ram.Dispose(); _vram.Dispose(); _cpu.Dispose(); _gpu.Dispose(); }
}

/// <summary>Fixed-length history of one reading, oldest first.</summary>
public sealed class History
{
    private double[] _buf;
    private int _start, _count;

    public History(int length) => _buf = new double[Math.Max(2, length)];

    public void Add(double v)
    {
        if (_count < _buf.Length) _buf[(_start + _count++) % _buf.Length] = v;
        else { _buf[_start] = v; _start = (_start + 1) % _buf.Length; }
    }

    public int Capacity => _buf.Length;

    public double[] ToArray()
    {
        var a = new double[_count];
        for (int i = 0; i < _count; i++) a[i] = _buf[(_start + i) % _buf.Length];
        return a;
    }

    public void Resize(int length)
    {
        var old = ToArray();
        _buf = new double[Math.Max(2, length)];
        _start = _count = 0;
        foreach (var v in old.Skip(Math.Max(0, old.Length - _buf.Length))) Add(v);
    }
}

/// <summary>Runs the sampler on its own thread at the configured interval, only while the widget is showing.</summary>
public sealed class SamplingLoop : IDisposable
{
    private readonly HardwareSampler _hw;
    private readonly AppUsageSampler _apps = new();
    private readonly Func<AppConfig> _config;
    private CancellationTokenSource? _cts;
    private volatile bool _wantApps;
    private readonly AutoResetEvent _wake = new(false);
    private double _hwMs, _appsMs;
    private int _hwCount, _appsCount;

    public event Action<Snapshot, AppUsage?>? Sampled;

    public SamplingLoop(HardwareSampler hw, Func<AppConfig> config) { _hw = hw; _config = config; }

    public bool Running => _cts != null;

    /// <summary>Whether to read RAM and VRAM per app as well. Turning it on reads straight away.</summary>
    public bool WantApps
    {
        get => _wantApps;
        set { bool was = _wantApps; _wantApps = value; if (value && !was) _wake.Set(); }
    }

    public void Start()
    {
        if (_cts != null) return;
        var cts = _cts = new CancellationTokenSource();
        var thread = new Thread(() => Run(cts.Token)) { IsBackground = true, Name = "Vitals sampler", Priority = ThreadPriority.BelowNormal };
        thread.Start();
    }

    public void Stop()
    {
        _cts?.Cancel();
        _cts = null;
        _wake.Set();
    }

    private void Run(CancellationToken ct)
    {
        while (!ct.IsCancellationRequested)
        {
            var started = Environment.TickCount64;
            try
            {
                var sw = Stopwatch.StartNew();
                var snap = _hw.Sample();
                double hwMs = sw.Elapsed.TotalMilliseconds;
                AppUsage? apps = null;
                if (_wantApps)
                {
                    sw.Restart();
                    apps = _apps.Sample(_config().AppsListed, snap.VramUsedGB, snap.VramTotalGB);
                    _appsMs += sw.Elapsed.TotalMilliseconds; _appsCount++;
                }
                _hwMs += hwMs;
                // Once, after 60 readings: how long a reading takes, for the README's cost figures.
                if (++_hwCount == 60) Log.Write($"Average reading time over 60 readings: {_hwMs / 60:0.0} ms ({_hw.Timing()})" +
                    (_appsCount > 0 ? $"; per-app breakdown {_appsMs / _appsCount:0.0} ms over {_appsCount}" : "; breakdown not opened yet"));
                if (!ct.IsCancellationRequested) Sampled?.Invoke(snap, apps);
            }
            catch (Exception ex) { Log.Write($"Sampling failed: {ex.Message}"); }

            int wait = (int)Math.Max(50, _config().UpdateIntervalMs - (Environment.TickCount64 - started));
            _wake.WaitOne(wait);
        }
    }

    public void Dispose() { Stop(); _apps.Dispose(); }
}
