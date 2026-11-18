using System;
using System.IO;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;

namespace Vitals;

public sealed class AppConfig
{
    // Shown in Settings.
    public bool StartWithWindows { get; set; }
    public bool StartExpanded { get; set; }
    public bool AlwaysOnTop { get; set; } = true;
    public bool LockPosition { get; set; } = false;
    public bool SnapToCorners { get; set; } = true;
    public double Opacity { get; set; } = 0.9;

    // Config file only.
    public bool RunAsAdmin { get; set; } = true;
    public int UpdateIntervalMs { get; set; } = 1000;
    public int GraphHistorySeconds { get; set; } = 60;
    public int AppsListed { get; set; } = 3;
    public bool AskClaudeForWarnings { get; set; } = true;
    public WarningConfig Warnings { get; set; } = new();

    // Remembered by the widget.
    public bool Expanded { get; set; }
    public WidgetPosition? Position { get; set; }
}

/// <summary>The widget's bottom-right corner, in screen pixels.</summary>
public sealed class WidgetPosition
{
    public int Right { get; set; }
    public int Bottom { get; set; }
}

public sealed class WarningConfig
{
    public TempWarning? Cpu { get; set; }
    public TempWarning? Gpu { get; set; }
    public RatioWarning Vram { get; set; } = new() { Amber = 0.85, Red = 0.95 };
}

public sealed class TempWarning
{
    public string Model { get; set; } = "";
    public int Amber { get; set; }
    public int Red { get; set; }
    /// <summary>The maximum the hardware reports (TjMax, GPU slowdown temperature), when it reports one.</summary>
    public int? Limit { get; set; }
    /// <summary>"claude", "fallback" or "manual".</summary>
    public string SetBy { get; set; } = "fallback";
    public string? Date { get; set; }
    public string? Reason { get; set; }
}

public sealed class RatioWarning
{
    public double Amber { get; set; }
    public double Red { get; set; }
}

/// <summary>Loads and saves %APPDATA%\Vitals\config.json, and reloads it when it's edited by hand.</summary>
public sealed class ConfigStore : IDisposable
{
    public static readonly string Folder = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Vitals");
    public static readonly string FilePath = Path.Combine(Folder, "config.json");

    private static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        ReadCommentHandling = JsonCommentHandling.Skip,
        AllowTrailingCommas = true,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
    };

    private readonly object _lock = new();
    private FileSystemWatcher? _watcher;
    private Timer? _debounce;
    private string _lastWritten = "";

    public AppConfig Current { get; private set; } = new();

    /// <summary>Raised (on a worker thread) after the file was changed outside Vitals and reloaded.</summary>
    public event Action? ReloadedFromDisk;

    public void Load()
    {
        Directory.CreateDirectory(Folder);
        if (File.Exists(FilePath))
        {
            try
            {
                var text = File.ReadAllText(FilePath);
                Current = JsonSerializer.Deserialize<AppConfig>(text, Json) ?? new AppConfig();
                _lastWritten = text;
            }
            catch (Exception ex)
            {
                Log.Write($"config.json couldn't be read, using defaults: {ex.Message}");
                Current = new AppConfig();
            }
        }
        Clamp(Current);
        Save();
        Watch();
    }

    public void Save()
    {
        lock (_lock)
        {
            var text = JsonSerializer.Serialize(Current, Json);
            if (text == _lastWritten && File.Exists(FilePath)) return;
            _lastWritten = text;
            var temp = FilePath + ".tmp";
            File.WriteAllText(temp, text);
            File.Move(temp, FilePath, true);
        }
    }

    private static void Clamp(AppConfig c)
    {
        c.Opacity = Math.Clamp(c.Opacity, 0.2, 1.0);
        c.UpdateIntervalMs = Math.Clamp(c.UpdateIntervalMs, 250, 10000);
        c.GraphHistorySeconds = Math.Clamp(c.GraphHistorySeconds, 10, 600);
        c.AppsListed = Math.Clamp(c.AppsListed, 1, 10);
        c.Warnings ??= new WarningConfig();
        c.Warnings.Vram ??= new RatioWarning { Amber = 0.85, Red = 0.95 };
    }

    private void Watch()
    {
        _watcher = new FileSystemWatcher(Folder, "config.json") { NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.FileName };
        _debounce = new Timer(_ => ReloadIfChanged(), null, Timeout.Infinite, Timeout.Infinite);
        FileSystemEventHandler h = (_, _) => _debounce.Change(300, Timeout.Infinite);
        _watcher.Changed += h;
        _watcher.Created += h;
        _watcher.Renamed += (_, _) => _debounce.Change(300, Timeout.Infinite);
        _watcher.EnableRaisingEvents = true;
    }

    private void ReloadIfChanged()
    {
        try
        {
            string text;
            lock (_lock)
            {
                text = File.ReadAllText(FilePath);
                if (text == _lastWritten) return;
            }
            var loaded = JsonSerializer.Deserialize<AppConfig>(text, Json);
            if (loaded == null) return;
            Clamp(loaded);
            lock (_lock) { Current = loaded; _lastWritten = text; }
            Log.Write("config.json changed on disk; reloaded.");
            ReloadedFromDisk?.Invoke();
        }
        catch (Exception ex)
        {
            Log.Write($"config.json edit ignored (not valid JSON yet?): {ex.Message}");
        }
    }

    public void Dispose()
    {
        _watcher?.Dispose();
        _debounce?.Dispose();
    }
}

internal static class Log
{
    private static readonly object Lock = new();
    private static readonly string FilePath = Path.Combine(ConfigStore.Folder, "vitals.log");

    public static void Write(string message)
    {
        try
        {
            lock (Lock)
            {
                Directory.CreateDirectory(ConfigStore.Folder);
                var fi = new FileInfo(FilePath);
                if (fi.Exists && fi.Length > 512 * 1024) File.Delete(FilePath);
                File.AppendAllText(FilePath, $"{DateTime.Now:yyyy-MM-dd HH:mm:ss}  {message}{Environment.NewLine}");
            }
        }
        catch { /* logging must never break the widget */ }
    }
}
