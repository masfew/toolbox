using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace Vitals;

/// <summary>
/// Writes one line a second of the PC's load to %APPDATA%\Vitals\history\, one CSV file per hour
/// (yyyy-MM-dd_HH.csv, local time), and keeps the last <see cref="KeepHours"/> hours. It runs on its own thread
/// whether the widget is showing or hidden, so after a freeze or stutter there's a per-second record to look back at.
/// </summary>
/// <remarks>
/// Columns: time (local, with milliseconds); gap_ms (time since the line before: well over 1000 means Vitals itself
/// was held up, which a system-wide stall does too; blank on the first line after a start); cpu (% of the whole CPU);
/// core_max (busiest logical core, %); core_dpc and core_int (the highest share of any one core spent in deferred
/// procedure calls and in interrupts, where misbehaving drivers show up); gpu (%); gpu_temp (°C); vram_gb; ram_gb
/// (in use); commit_gb and commit_limit_gb (memory promised to apps, and the most Windows can promise before it runs
/// out, RAM plus page file); hard_faults (pages read back from disk per second, high when RAM runs short);
/// disk_active (busiest physical disk, % of the time busy); disk_queue (requests waiting on all disks);
/// top_cpu (the three apps using the most CPU, % of the whole CPU, summed over each app's processes; only when cpu
/// is at least <see cref="TopCpuThreshold"/>% or after a gap of 2 s or more; the first such second measures the
/// apps over a quarter of a second, later ones over the whole second).
/// </remarks>
public sealed class HistoryLog : IDisposable
{
    public static readonly string Folder = Path.Combine(ConfigStore.Folder, "history");
    public const int KeepHours = 24;
    /// <summary>A second cap, for a clock change or a burst of extra-long lines: the oldest files go first.</summary>
    private const long MaxFolderBytes = 64L * 1024 * 1024;
    public const double TopCpuThreshold = 50;
    private const int IntervalMs = 1000;
    private const int StallMs = 2000;
    private const int AppWarmUpMs = 250;

    private const string Header = "time,gap_ms,cpu,core_max,core_dpc,core_int,gpu,gpu_temp,vram_gb,ram_gb,commit_gb,commit_limit_gb,hard_faults,disk_active,disk_queue,top_cpu";

    private CancellationTokenSource? _cts;
    private Thread? _thread;

    public void Start()
    {
        if (_cts != null) return;
        var cts = _cts = new CancellationTokenSource();
        // Above normal so it keeps its once-a-second line while apps saturate the CPU; each line takes about a millisecond.
        _thread = new Thread(() => Run(cts.Token)) { IsBackground = true, Name = "Vitals history", Priority = ThreadPriority.AboveNormal };
        _thread.Start();
    }

    public void Dispose()
    {
        _cts?.Cancel();
        _thread?.Join(2000);
        _cts = null;
    }

    private void Run(CancellationToken ct)
    {
        Recorder? rec = null;
        try { rec = new Recorder(); }
        catch (Exception ex) { Log.Write($"History log didn't start: {ex.Message}"); return; }

        using (rec)
        {
            long next = Environment.TickCount64 + IntervalMs;
            ct.WaitHandle.WaitOne(IntervalMs);
            while (!ct.IsCancellationRequested)
            {
                try { rec.WriteLine(); }
                catch (Exception ex) { rec.Failed(ex); }
                next += IntervalMs;
                long now = Environment.TickCount64;
                if (next < now) next = now + IntervalMs; // held up for a whole interval or more: don't catch up in a burst
                ct.WaitHandle.WaitOne((int)(next - now));
            }
        }
    }

    /// <summary>Reads the counters and writes lines. Only the history thread uses it.</summary>
    private sealed class Recorder : IDisposable
    {
        // Collected together each second. [4] to [6] are wildcards with an instance per logical core.
        private readonly PdhCounter _cpu = new(
            @"\Processor Information(_Total)\% Processor Utility",
            @"\Memory\Pages Input/sec",
            @"\Processor Information(*)\% Processor Utility",
            @"\Processor Information(*)\% DPC Time",
            @"\Processor Information(*)\% Interrupt Time");
        // Apart from the CPU's, since disk counters can be turned off (diskperf) and one failed counter fails its query.
        private readonly PdhCounter _disk = new(@"\PhysicalDisk(*)\% Idle Time", @"\PhysicalDisk(*)\Current Disk Queue Length");
        private readonly ProcessCpu _procs = new();
        private readonly IntPtr _gpu;
        private readonly bool _nvmlOk;
        private readonly StringBuilder _line = new(256);

        private StreamWriter? _file;
        private string? _filePath;
        private long _lastTicks;
        private int _lines, _failures;
        private double _totalMs;
        private readonly long[] _partTicks = new long[6];

        public Recorder()
        {
            Directory.CreateDirectory(Folder);
            // Rate counters and per-app CPU need two readings; this is the first, a second before the first line.
            _cpu.Collect(); _disk.Collect();
            try { _nvmlOk = Nvml.nvmlInit_v2() == 0 && Nvml.nvmlDeviceGetHandleByIndex_v2(0, out _gpu) == 0; }
            catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException) { }
            Prune();
        }

        public void WriteLine()
        {
            long t0 = Stopwatch.GetTimestamp();
            var now = DateTime.Now;
            double? gapMs = _lastTicks == 0 ? null : (t0 - _lastTicks) * 1000.0 / Stopwatch.Frequency;
            _lastTicks = t0;

            double? cpu = null, faults = null, coreMax = null, coreDpc = null, coreInt = null;
            if (_cpu.Collect())
            {
                cpu = _cpu.ReadDouble(0) is double c ? Math.Clamp(c, 0, 100) : null;
                faults = _cpu.ReadDouble(1);
                coreMax = MaxPerCore(2);
                coreDpc = MaxPerCore(3);
                coreInt = MaxPerCore(4);
            }

            long t1 = Stopwatch.GetTimestamp();
            double? diskActive = null, diskQueue = null;
            if (_disk.Collect())
            {
                foreach (var (name, idle) in _disk.ReadDoubleArray(0))
                    if (name != "_Total") diskActive = Math.Max(diskActive ?? 0, 100 - Math.Clamp(idle, 0, 100));
                foreach (var (name, queue) in _disk.ReadDoubleArray(1))
                    if (name == "_Total") diskQueue = queue;
            }

            long t2 = Stopwatch.GetTimestamp();
            double? gpu = null, gpuTemp = null, vram = null;
            if (_nvmlOk)
            {
                if (Nvml.nvmlDeviceGetUtilizationRates(_gpu, out var u) == 0) gpu = u.Gpu;
                if (Nvml.nvmlDeviceGetTemperature(_gpu, Nvml.TEMPERATURE_GPU, out var t) == 0) gpuTemp = t;
                if (Nvml.nvmlDeviceGetMemoryInfo(_gpu, out var m) == 0) vram = m.Used / 1073741824.0;
            }

            long tMem = Stopwatch.GetTimestamp();
            var mem = new Native.MEMORYSTATUSEX { dwLength = (uint)Marshal.SizeOf<Native.MEMORYSTATUSEX>() };
            double? ram = null, commit = null, commitLimit = null;
            if (Native.GlobalMemoryStatusEx(ref mem))
            {
                ram = (mem.ullTotalPhys - mem.ullAvailPhys) / 1073741824.0;
                commit = (mem.ullTotalPageFile - mem.ullAvailPageFile) / 1073741824.0;
                commitLimit = mem.ullTotalPageFile / 1073741824.0;
            }

            // Read only when busy: listing every process costs about 4 ms, most of a line's cost. The first busy second
            // after a quiet spell reads twice, AppWarmUpMs apart, since CPU use per app needs a starting point.
            long t3 = Stopwatch.GetTimestamp(), waited = 0;
            string? top = null;
            if (cpu >= TopCpuThreshold || gapMs >= StallMs)
            {
                if (!_procs.HasRecentReading)
                {
                    _procs.Read(0);
                    long w = Stopwatch.GetTimestamp();
                    Thread.Sleep(AppWarmUpMs);
                    waited = Stopwatch.GetTimestamp() - w; // not work: kept out of the timing below
                }
                top = _procs.Read(3);
            }
            long t4 = Stopwatch.GetTimestamp();

            var l = _line.Clear();
            l.Append(now.ToString("HH:mm:ss.fff", CultureInfo.InvariantCulture));
            Add(l, gapMs, "0"); Add(l, cpu, "0.0"); Add(l, coreMax, "0"); Add(l, coreDpc, "0.0"); Add(l, coreInt, "0.0");
            Add(l, gpu, "0"); Add(l, gpuTemp, "0"); Add(l, vram, "0.00"); Add(l, ram, "0.00"); Add(l, commit, "0.00"); Add(l, commitLimit, "0.0");
            Add(l, faults, "0"); Add(l, diskActive, "0"); Add(l, diskQueue, "0");
            l.Append(',').Append(top);

            FileFor(now).WriteLine(l);
            _file!.Flush(); // a line a second, on disk at once, so a crash or power cut loses at most one

            long t5 = Stopwatch.GetTimestamp();
            _partTicks[0] += t1 - t0; _partTicks[1] += t2 - t1; _partTicks[2] += tMem - t2; _partTicks[5] += t3 - tMem; _partTicks[3] += t4 - t3 - waited; _partTicks[4] += t5 - t4;
            _totalMs += (t5 - t0 - waited) * 1000.0 / Stopwatch.Frequency;
            // Once, after 60 lines: how long a line takes, for the README's cost figures.
            if (++_lines == 60)
            {
                string Ms(int i) => (_partTicks[i] * 1000.0 / Stopwatch.Frequency / 60).ToString("0.00", CultureInfo.InvariantCulture);
                Log.Write($"History log: average {_totalMs / 60:0.00} ms per line over 60 lines (CPU counters {Ms(0)} ms, disk {Ms(1)} ms, " +
                          $"GPU {Ms(2)} ms, RAM {Ms(5)} ms, apps {Ms(3)} ms, writing {Ms(4)} ms), in {Folder}");
            }
        }

        public void Failed(Exception ex)
        {
            // A full or read-only disk would fail every second: log the first few, then stay quiet.
            if (++_failures <= 3) Log.Write($"History log couldn't write a line: {ex.Message}");
            _file?.Dispose();
            _file = null; _filePath = null;
        }

        private double? MaxPerCore(int index)
        {
            double? max = null;
            foreach (var (name, value) in _cpu.ReadDoubleArray(index))
                if (!name.Contains("_Total", StringComparison.Ordinal)) max = Math.Max(max ?? 0, Math.Clamp(value, 0, 100));
            return max;
        }

        private static void Add(StringBuilder l, double? value, string format)
        {
            l.Append(',');
            if (value is double v && double.IsFinite(v)) l.Append(v.ToString(format, CultureInfo.InvariantCulture));
        }

        private StreamWriter FileFor(DateTime now)
        {
            string path = Path.Combine(Folder, now.ToString("yyyy-MM-dd_HH", CultureInfo.InvariantCulture) + ".csv");
            if (_file != null && path == _filePath) return _file;
            _file?.Dispose();
            bool fresh = !File.Exists(path) || new FileInfo(path).Length == 0;
            // Shared so the file can be opened while it's being written.
            var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite | FileShare.Delete);
            _file = new StreamWriter(fs, new UTF8Encoding(false)) { NewLine = "\r\n" };
            _filePath = path;
            if (fresh) _file.WriteLine(Header);
            Prune();
            return _file;
        }

        /// <summary>Deletes hour files older than <see cref="KeepHours"/>, then the oldest while the folder is over its size cap.</summary>
        private void Prune()
        {
            try
            {
                var cutoff = DateTime.Now.AddHours(-KeepHours - 1); // a file's name is the start of its hour
                var files = new DirectoryInfo(Folder).GetFiles("*.csv")
                    .Select(f => (File: f, Hour: DateTime.TryParseExact(Path.GetFileNameWithoutExtension(f.Name), "yyyy-MM-dd_HH",
                        CultureInfo.InvariantCulture, DateTimeStyles.None, out var h) ? h : (DateTime?)null))
                    .Where(x => x.Hour != null)
                    .OrderBy(x => x.Hour)
                    .ToList();
                long total = files.Sum(x => x.File.Length);
                foreach (var (file, hour) in files)
                {
                    if (file.FullName == _filePath) continue;
                    if (hour >= cutoff && total <= MaxFolderBytes) continue;
                    total -= file.Length;
                    try { file.Delete(); } catch { }
                }
            }
            catch (Exception ex) { Log.Write($"History log couldn't tidy its folder: {ex.Message}"); }
        }

        public void Dispose()
        {
            _file?.Dispose();
            _cpu.Dispose();
            _disk.Dispose();
            _procs.Dispose();
            if (_nvmlOk) try { Nvml.nvmlShutdown(); } catch { }
        }
    }
}

/// <summary>
/// CPU use per app from one NtQuerySystemInformation call, which lists every process with its CPU time so far. Much
/// cheaper than the per-process performance counters, so it can run every second.
/// </summary>
internal sealed class ProcessCpu : IDisposable
{
    [DllImport("ntdll.dll")] private static extern int NtQuerySystemInformation(int infoClass, IntPtr buffer, int length, out int returnLength);
    private const int SystemProcessInformation = 5;
    private const int STATUS_INFO_LENGTH_MISMATCH = unchecked((int)0xC0000004);

    // SYSTEM_PROCESS_INFORMATION on 64-bit Windows.
    private const int OffNext = 0, OffCreate = 32, OffUser = 40, OffKernel = 48, OffNameLength = 56, OffNameBuffer = 64, OffPid = 80;

    private IntPtr _buf;
    private int _size = 1 << 20;
    private Dictionary<long, (long Create, long Cpu)> _prev = new(), _cur = new();
    private long _prevTicks;

    /// <summary>Whether the last reading was recent enough to measure the next one against.</summary>
    public bool HasRecentReading => _prevTicks != 0 && Stopwatch.GetElapsedTime(_prevTicks).TotalMilliseconds < 1500;
    private readonly Dictionary<string, double> _byApp = new(StringComparer.OrdinalIgnoreCase);

    public ProcessCpu()
    {
        if (IntPtr.Size != 8) throw new PlatformNotSupportedException("needs 64-bit Windows");
        _buf = Marshal.AllocHGlobal(_size);
    }

    /// <summary>Takes this second's CPU times. With <paramref name="top"/> above 0, also returns the busiest apps
    /// since the last call, as "name=percent;..." with the percent of the whole CPU; else null.</summary>
    public string? Read(int top)
    {
        int len;
        int status;
        while ((status = NtQuerySystemInformation(SystemProcessInformation, _buf, _size, out len)) == STATUS_INFO_LENGTH_MISMATCH)
        {
            Marshal.FreeHGlobal(_buf);
            _size = Math.Max(_size * 2, len + (1 << 16));
            _buf = Marshal.AllocHGlobal(_size);
        }
        if (status < 0) return null;

        long ticks = Stopwatch.GetTimestamp();
        double elapsed100ns = _prevTicks == 0 ? 0 : (ticks - _prevTicks) * 1e7 / Stopwatch.Frequency;
        double scale = elapsed100ns > 0 ? 100.0 / (elapsed100ns * Math.Max(1, Environment.ProcessorCount)) : 0;
        _prevTicks = ticks;
        _cur.Clear();
        if (top > 0) _byApp.Clear();

        int offset = 0;
        while (true)
        {
            IntPtr p = _buf + offset;
            long pid = Marshal.ReadIntPtr(p, OffPid).ToInt64();
            long create = Marshal.ReadInt64(p, OffCreate);
            long cpu = Marshal.ReadInt64(p, OffUser) + Marshal.ReadInt64(p, OffKernel);
            if (pid != 0) // 0 is the idle process
            {
                _cur[pid] = (create, cpu);
                // A process seen last time (same pid and start time) used the difference; a new one counts from 0.
                if (top > 0 && scale > 0)
                {
                    long before = _prev.TryGetValue(pid, out var prev) && prev.Create == create ? prev.Cpu : 0;
                    long used = cpu - before;
                    if (used > 0)
                    {
                        int nameBytes = (ushort)Marshal.ReadInt16(p, OffNameLength);
                        IntPtr namePtr = Marshal.ReadIntPtr(p, OffNameBuffer);
                        string name = nameBytes > 0 && namePtr != IntPtr.Zero ? Marshal.PtrToStringUni(namePtr, nameBytes / 2) : "System";
                        _byApp[name] = _byApp.GetValueOrDefault(name) + used * scale;
                    }
                }
            }
            int next = Marshal.ReadInt32(p, OffNext);
            if (next == 0) break;
            offset += next;
        }
        (_prev, _cur) = (_cur, _prev);

        if (top <= 0 || _byApp.Count == 0) return null;
        return string.Join(";", _byApp.OrderByDescending(kv => kv.Value).Take(top)
            .Select(kv => $"{kv.Key.Replace(',', '_').Replace(';', '_').Replace('=', '_')}={Math.Min(100, kv.Value).ToString("0.0", CultureInfo.InvariantCulture)}"));
    }

    public void Dispose()
    {
        if (_buf != IntPtr.Zero) Marshal.FreeHGlobal(_buf);
        _buf = IntPtr.Zero;
    }
}
