using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;

namespace Vitals;

/// <summary>
/// Picks the temperatures where CPU and GPU readings turn amber and red, for the hardware in this PC.
/// When the CPU or GPU model differs from the one saved in config.json (first run, or new hardware), it saves
/// fallback levels from the limit the chip reports, then asks Claude Code (claude -p) for levels that fit how that
/// chip normally runs, checks the answer and saves it. Levels set by hand ("setBy": "manual") are never replaced.
/// </summary>
internal sealed class WarningLevels
{
    private readonly ConfigStore _store;
    private readonly HardwareSampler _hw;

    public WarningLevels(ConfigStore store, HardwareSampler hw) { _store = store; _hw = hw; }

    public async Task CheckAsync()
    {
        var w = _store.Current.Warnings;
        bool cpuNew = Needs(w.Cpu, _hw.CpuModel);
        bool gpuNew = _hw.GpuModel != null && Needs(w.Gpu, _hw.GpuModel);
        if (!cpuNew && !gpuNew) return;

        int cpuLimit = _hw.CpuLimit ?? (_hw.CpuModel.Contains("AMD", StringComparison.OrdinalIgnoreCase) ? 95 : 100);
        int gpuLimit = _hw.GpuLimit ?? 90;

        if (cpuNew && w.Cpu?.Model != _hw.CpuModel) w.Cpu = Fallback(_hw.CpuModel, cpuLimit, _hw.CpuLimit);
        if (gpuNew && w.Gpu?.Model != _hw.GpuModel) w.Gpu = Fallback(_hw.GpuModel!, gpuLimit, _hw.GpuLimit);
        _store.Save();
        Log.Write($"Warning levels set from the hardware's limits for {_hw.CpuModel} / {_hw.GpuModel}.");

        if (!_store.Current.AskClaudeForWarnings) return;
        var answer = await Task.Run(() => AskClaude(cpuLimit, gpuLimit));
        if (answer == null) return;

        var (cpu, gpu) = answer.Value;
        string today = DateTime.Now.ToString("yyyy-MM-dd");
        if (cpuNew && Valid(cpu, cpuLimit)) w.Cpu = new TempWarning { Model = _hw.CpuModel, Amber = cpu.Amber, Red = cpu.Red, Limit = _hw.CpuLimit, SetBy = "claude", Date = today, Reason = cpu.Reason };
        if (gpuNew && Valid(gpu, gpuLimit)) w.Gpu = new TempWarning { Model = _hw.GpuModel!, Amber = gpu.Amber, Red = gpu.Red, Limit = _hw.GpuLimit, SetBy = "claude", Date = today, Reason = gpu.Reason };
        _store.Save();
        Log.Write($"Claude set warning levels: CPU {w.Cpu?.Amber}/{w.Cpu?.Red}, GPU {w.Gpu?.Amber}/{w.Gpu?.Red}.");
    }

    /// <summary>New hardware, or levels still at the fallback (Claude didn't answer last time).</summary>
    private static bool Needs(TempWarning? w, string model) =>
        w == null || w.Model != model || (w.SetBy == "fallback");

    private static TempWarning Fallback(string model, int limit, int? reported) => new()
    {
        Model = model, Amber = limit - 10, Red = limit - 3, Limit = reported, SetBy = "fallback",
        Date = DateTime.Now.ToString("yyyy-MM-dd"),
        Reason = $"Set from the {(reported != null ? "reported" : "typical")} limit of {limit} °C until Claude picks levels for this chip.",
    };

    private static bool Valid(Level l, int limit) => l.Amber >= 30 && l.Amber < l.Red && l.Red <= limit;

    private readonly record struct Level(int Amber, int Red, string Reason);

    private (Level Cpu, Level Gpu)? AskClaude(int cpuLimit, int gpuLimit)
    {
        string? exe = FindClaude();
        if (exe == null) { Log.Write("Claude Code (claude.exe) not found; keeping fallback warning levels."); return null; }

        string prompt =
            "A desktop hardware monitor colours temperatures amber (warm, worth noticing) and red (too hot, something is wrong). " +
            "Pick the two thresholds in degrees Celsius for this hardware, based on its specified maximum (TjMax, or the GPU's max or slowdown temperature) " +
            "and how it normally behaves under heavy sustained load, so normal heavy use stays below amber. " +
            $"CPU: {_hw.CpuModel} (limit {cpuLimit} C{(_hw.CpuLimit == null ? ", typical for this vendor, not read from the chip" : "")}). " +
            $"GPU: {_hw.GpuModel ?? "none"} (slowdown temperature {gpuLimit} C{(_hw.GpuLimit == null ? ", assumed" : "")}). " +
            "Rules: amber below red, red at or below the limit. Give a one-sentence reason for each.";
        const string schema = """{"type":"object","properties":{"cpu":{"type":"object","properties":{"amber":{"type":"integer"},"red":{"type":"integer"},"reason":{"type":"string"}},"required":["amber","red","reason"]},"gpu":{"type":"object","properties":{"amber":{"type":"integer"},"red":{"type":"integer"},"reason":{"type":"string"}},"required":["amber","red","reason"]}},"required":["cpu","gpu"]}""";

        string work = Path.Combine(Path.GetTempPath(), "Vitals");
        Directory.CreateDirectory(work);
        var psi = new ProcessStartInfo(exe)
        {
            WorkingDirectory = work, CreateNoWindow = true, UseShellExecute = false,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        // No settings files (so no hooks or plugins), no MCP servers, web search only, nothing saved.
        foreach (var a in new[] { "-p", prompt, "--output-format", "json", "--json-schema", schema, "--tools", "WebSearch",
                                  "--allowedTools", "WebSearch", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence", "--model", "sonnet" })
            psi.ArgumentList.Add(a);

        try
        {
            using var p = Process.Start(psi)!;
            var stdout = p.StandardOutput.ReadToEndAsync();
            var stderr = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(180_000)) { try { p.Kill(true); } catch { } Log.Write("Claude Code took over 3 minutes; keeping fallback warning levels."); return null; }
            using var doc = JsonDocument.Parse(stdout.Result);
            var root = doc.RootElement;
            if (root.TryGetProperty("is_error", out var err) && err.GetBoolean()) { Log.Write($"Claude Code returned an error: {Trim(stdout.Result)}"); return null; }
            JsonElement data = root.TryGetProperty("structured_output", out var so) && so.ValueKind == JsonValueKind.Object
                ? so
                : JsonDocument.Parse(root.GetProperty("result").GetString() ?? "{}").RootElement;
            return (Read(data.GetProperty("cpu")), Read(data.GetProperty("gpu")));
        }
        catch (Exception ex)
        {
            Log.Write($"Asking Claude Code for warning levels failed: {ex.Message}");
            return null;
        }
    }

    private static Level Read(JsonElement e) => new(e.GetProperty("amber").GetInt32(), e.GetProperty("red").GetInt32(), e.GetProperty("reason").GetString() ?? "");

    private static string Trim(string s) => s.Length > 300 ? s[..300] + "…" : s;

    private static string? FindClaude()
    {
        string local = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".local", "bin", "claude.exe");
        if (File.Exists(local)) return local;
        var path = Environment.GetEnvironmentVariable("PATH") ?? "";
        return path.Split(Path.PathSeparator).Select(d => Path.Combine(d.Trim(), "claude.exe")).FirstOrDefault(File.Exists);
    }
}
