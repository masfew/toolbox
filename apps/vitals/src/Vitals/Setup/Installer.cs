using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Threading;

namespace Vitals.Setup;

/// <summary>What the person chose in Setup.</summary>
public sealed record SetupChoices(bool StartWithWindows, bool ClaudeLevels);

/// <summary>
/// The install steps behind Setup (Vitals.exe --setup): closes a running Vitals, copies this build to
/// %LOCALAPPDATA%\Programs\Vitals, adds the Start menu shortcut, creates or removes the Start with Windows task (Windows'
/// administrator prompt) and saves the choices to config.json. It reads LOCALAPPDATA and APPDATA from the environment,
/// as install.py sets them, so a test install can go to a test folder.
/// </summary>
public sealed class Installer
{
    private const string CloseEventName = @"Local\Vitals.Close"; // App.xaml.cs makes it
    private const string InstallPidFile = "Vitals.install-pid";  // App.StartAgainAfterInstall reads it
    private const string NoRestartFile = "Vitals.no-restart";    // ...and skips the restart while this exists

    public static string LocalAppData => Env("LOCALAPPDATA", Environment.SpecialFolder.LocalApplicationData);
    public static string AppData => Env("APPDATA", Environment.SpecialFolder.ApplicationData);
    public static string InstallDir => Path.Combine(LocalAppData, "Programs", "Vitals");
    public static string InstalledExe => Path.Combine(InstallDir, "Vitals.exe");
    public static string StartMenuLink => Path.Combine(AppData, "Microsoft", "Windows", "Start Menu", "Programs", "Vitals.lnk");
    public static string ConfigFile => Path.Combine(AppData, "Vitals", "config.json");

    /// <summary>For tests and recordings: leaves the two parts that reach the whole Windows account alone (a running
    /// Vitals, and the Start with Windows task, which is one per account), and says so in each step.</summary>
    public bool TestMode { get; init; }

    /// <summary>Called as each step starts, with its text.</summary>
    public Action<string>? StepStarted { get; init; }
    /// <summary>Called when Windows' administrator prompt is about to show (true) and once it's answered (false).</summary>
    public Action<bool>? AdminPrompt { get; init; }
    /// <summary>Lines for the install log install.py prints.</summary>
    public Action<string>? Log { get; init; }

    /// <summary>A Vitals was running and closed on the close event, so it starts again by itself once Setup ends.</summary>
    public bool RestartsItself { get; private set; }
    /// <summary>A Vitals was running and Setup stopped it, so Setup starts it again.</summary>
    public bool WasStopped { get; private set; }
    /// <summary>Whether Start with Windows is on once Setup ran.</summary>
    public bool StartWithWindowsOn { get; private set; }
    /// <summary>Why Start with Windows didn't change as asked, or null.</summary>
    public string? StartWithWindowsProblem { get; private set; }

    public static bool IsUpdate => File.Exists(InstalledExe);

    /// <summary>Runs every step. Throws <see cref="SetupException"/> with a message for the person when one fails.</summary>
    public void Run(SetupChoices choices, bool claudeAvailable)
    {
        Step("Closing Vitals, if it's running");
        CloseRunningVitals();
        Step("Copying Vitals to your user folder");
        Copy();
        Step("Adding Vitals to the Start menu");
        AddShortcut();
        Step(choices.StartWithWindows ? "Setting up Start with Windows" : "Checking Start with Windows");
        SetStartWithWindows(choices.StartWithWindows);
        Step("Saving your choices");
        SaveChoices(choices, claudeAvailable);
    }

    /// <summary>Starts the installed Vitals, or, when it restarts by itself, lets it (or stops that when not wanted).</summary>
    public void Finish(bool startNow)
    {
        string noRestart = Path.Combine(Path.GetTempPath(), NoRestartFile);
        if (RestartsItself)
        {
            if (!startNow) File.WriteAllText(noRestart, "");
            Write(startNow ? "Vitals starts again when Setup closes." : "Vitals stays closed.");
            return;
        }
        if (!startNow) return;
        if (TestMode) { Write("Test mode: didn't start Vitals."); return; }
        // --elevate-tried brings back a Vitals Setup stopped with the rights it had, without asking for admin.
        var psi = new ProcessStartInfo(InstalledExe) { UseShellExecute = true, WorkingDirectory = InstallDir };
        if (WasStopped) psi.ArgumentList.Add("--elevate-tried");
        using var _ = Process.Start(psi);
        Write("Started Vitals.");
    }

    private void Step(string text)
    {
        if (TestMode) Thread.Sleep(600); // so a recording shows each step
        StepStarted?.Invoke(text);
        Write(text + "...");
    }
    private void Write(string line) => Log?.Invoke(line);

    private static string Env(string name, Environment.SpecialFolder fallback) =>
        Environment.GetEnvironmentVariable(name) is string v && v.Length > 0 ? v : Environment.GetFolderPath(fallback);

    // ---------- closing a running Vitals ----------

    private static int[] OtherVitals()
    {
        var ids = Process.GetProcessesByName("Vitals").Select(p => { int id = p.Id; p.Dispose(); return id; }).ToArray();
        return ids.Where(id => id != Environment.ProcessId).ToArray();
    }

    private static bool WaitClosed(int seconds)
    {
        var deadline = DateTime.UtcNow.AddSeconds(seconds);
        while (OtherVitals().Length > 0)
        {
            if (DateTime.UtcNow > deadline) return false;
            Thread.Sleep(250);
        }
        return true;
    }

    private void CloseRunningVitals()
    {
        File.Delete(Path.Combine(Path.GetTempPath(), NoRestartFile)); // left by an earlier Setup that wasn't read
        if (OtherVitals().Length == 0) { Write("Vitals wasn't running."); return; }
        if (TestMode) { Write("Test mode: left the running Vitals alone."); return; }

        // Asked to close through its event, Vitals reads this file and starts again, with the rights it had, once
        // this process ends. Killing it can't close a Vitals running as administrator, but the event can.
        string pidFile = Path.Combine(Path.GetTempPath(), InstallPidFile);
        File.WriteAllText(pidFile, Environment.ProcessId.ToString());
        try
        {
            using var close = EventWaitHandle.OpenExisting(CloseEventName);
            close.Set();
            if (WaitClosed(20)) { RestartsItself = true; Write("Closed the running Vitals."); return; }
        }
        catch (Exception ex) when (ex is WaitHandleCannotBeOpenedException or UnauthorizedAccessException) { }
        finally { try { File.Delete(pidFile); } catch { } }

        foreach (int id in OtherVitals())
            try { using var p = Process.GetProcessById(id); p.Kill(); } catch { }
        if (WaitClosed(10)) { WasStopped = true; Write("Stopped the running Vitals."); return; }
        throw new SetupException("Vitals didn't close. It may be an older version running as administrator. Right-click " +
                                 "its tray icon, choose Close, then run Setup again.");
    }

    // ---------- files and shortcut ----------

    private void Copy()
    {
        string source = Path.GetFullPath(AppContext.BaseDirectory).TrimEnd('\\');
        string target = Path.GetFullPath(InstallDir).TrimEnd('\\');
        if (string.Equals(source, target, StringComparison.OrdinalIgnoreCase))
            throw new SetupException("Setup is running from the installed copy. Run it from the Vitals folder you downloaded instead.");
        // Copy next to it first, so a failed copy leaves the earlier install working.
        string staging = target + ".new";
        try
        {
            if (Directory.Exists(staging)) Directory.Delete(staging, true);
            CopyFolder(source, staging);
            if (Directory.Exists(target)) Directory.Delete(target, true);
            Directory.Move(staging, target);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new SetupException($"Couldn't copy Vitals to {target} ({ex.Message}). Close anything using it, then run Setup again.");
        }
        Write($"Installed Vitals in {target}.");
    }

    private static void CopyFolder(string from, string to)
    {
        Directory.CreateDirectory(to);
        foreach (var file in Directory.GetFiles(from)) File.Copy(file, Path.Combine(to, Path.GetFileName(file)));
        foreach (var dir in Directory.GetDirectories(from)) CopyFolder(dir, Path.Combine(to, Path.GetFileName(dir)));
    }

    private void AddShortcut()
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(StartMenuLink)!);
            dynamic shell = Activator.CreateInstance(Type.GetTypeFromProgID("WScript.Shell")!)!;
            dynamic link = shell.CreateShortcut(StartMenuLink);
            link.TargetPath = InstalledExe;
            link.WorkingDirectory = InstallDir;
            link.IconLocation = InstalledExe + ",0";
            link.Description = "A small always-on-top CPU, GPU, RAM and VRAM monitor";
            link.Save();
        }
        catch (Exception ex)
        {
            throw new SetupException($"Couldn't add the Start menu shortcut ({ex.Message}).");
        }
        Write($"Added the Start menu shortcut {StartMenuLink}.");
    }

    // ---------- Start with Windows ----------

    private void SetStartWithWindows(bool on)
    {
        if (TestMode)
        {
            // Shows where Windows' administrator prompt would appear, without one.
            if (on) { AdminPrompt?.Invoke(true); Thread.Sleep(3000); AdminPrompt?.Invoke(false); }
            StartWithWindowsOn = on;
            Write($"Test mode: didn't change the Start with Windows task (would turn it {(on ? "on" : "off")}).");
            return;
        }
        bool exists = StartupTask.Exists();
        if (exists == on) { StartWithWindowsOn = on; Write($"Start with Windows is already {(on ? "on" : "off")}."); return; }

        // The task starts Vitals as administrator, so creating or removing it needs Windows' administrator prompt.
        // The installed copy does it (--set-startup), so the task points at the installed Vitals.exe.
        AdminPrompt?.Invoke(true);
        string? problem = null;
        try
        {
            var psi = new ProcessStartInfo(InstalledExe) { UseShellExecute = true, Verb = "runas" };
            psi.ArgumentList.Add("--set-startup");
            psi.ArgumentList.Add(on ? "on" : "off");
            using var p = Process.Start(psi)!;
            if (!p.WaitForExit(120_000)) problem = "it took too long";
            else if (p.ExitCode != 0) problem = "Windows didn't accept the change";
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 1223) { problem = "Windows' permission wasn't given"; }
        catch (Win32Exception ex) { problem = ex.Message; }
        finally { AdminPrompt?.Invoke(false); }

        StartWithWindowsOn = StartupTask.Exists();
        if (StartWithWindowsOn != on) StartWithWindowsProblem = problem ?? "the change didn't take";
        Write(StartWithWindowsProblem == null
            ? $"Start with Windows is {(on ? "on" : "off")}."
            : $"Start with Windows stays {(StartWithWindowsOn ? "on" : "off")}: {StartWithWindowsProblem}.");
    }

    // ---------- config.json ----------

    private void SaveChoices(SetupChoices choices, bool claudeAvailable)
    {
        try
        {
            JsonObject config = File.Exists(ConfigFile)
                ? JsonNode.Parse(File.ReadAllText(ConfigFile), documentOptions: new JsonDocumentOptions
                  { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true }) as JsonObject ?? new JsonObject()
                : new JsonObject();
            config["startWithWindows"] = StartWithWindowsOn;
            if (claudeAvailable) config["askClaudeForWarnings"] = choices.ClaudeLevels;
            Directory.CreateDirectory(Path.GetDirectoryName(ConfigFile)!);
            File.WriteAllText(ConfigFile, config.ToJsonString(new JsonSerializerOptions { WriteIndented = true }));
            Write($"Saved your choices to {ConfigFile}.");
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            Write($"Couldn't save your choices to {ConfigFile} ({ex.Message}); change them in Vitals' Settings instead.");
        }
    }

    /// <summary>What the Options page starts with: the command line's answer, else the current state, else yes.</summary>
    public static SetupChoices DefaultChoices(bool? startWithWindows, bool? claudeLevels)
    {
        bool sww = startWithWindows ?? (!IsUpdate || StartupTask.Exists());
        bool claude = claudeLevels ?? ReadConfigBool("askClaudeForWarnings") ?? true;
        return new SetupChoices(sww, claude);
    }

    private static bool? ReadConfigBool(string key)
    {
        try
        {
            if (!File.Exists(ConfigFile)) return null;
            var node = JsonNode.Parse(File.ReadAllText(ConfigFile), documentOptions: new JsonDocumentOptions
                { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true });
            return node?[key]?.GetValue<bool>();
        }
        catch { return null; }
    }
}

public sealed class SetupException(string message) : Exception(message);

/// <summary>Whether Claude Code is there for Vitals to ask, and if not, why not, in words for the person.</summary>
public sealed record ClaudeCheck(bool Available, string Message)
{
    public static ClaudeCheck Run()
    {
        string? exe = WarningLevels.FindClaude();
        if (exe == null)
            return new(false, "Claude Code isn't installed on this PC, or Vitals can't find it: there's no claude.exe on your PATH " +
                              @"or in %USERPROFILE%\.local\bin. Vitals sets the warning levels a few degrees below each chip's own limit.");
        try
        {
            var psi = new ProcessStartInfo(exe) { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
            psi.ArgumentList.Add("--version");
            using var p = Process.Start(psi)!;
            var output = p.StandardOutput.ReadToEndAsync();
            _ = p.StandardError.ReadToEndAsync();
            if (!p.WaitForExit(15_000)) { try { p.Kill(true); } catch { } return new(false, $"Claude Code at {exe} didn't answer, so Vitals can't use it. Vitals sets the warning levels a few degrees below each chip's own limit."); }
            if (p.ExitCode != 0) return new(false, $"Claude Code at {exe} didn't start (it exited with code {p.ExitCode}), so Vitals can't use it. Vitals sets the warning levels a few degrees below each chip's own limit.");
            string version = output.Result.Trim().Split('\n')[0].Trim();
            return new(true, $"Found {(version.Length > 0 ? version : "Claude Code")} at {exe}.");
        }
        catch (Exception ex)
        {
            return new(false, $"Claude Code at {exe} didn't start ({ex.Message}), so Vitals can't use it. Vitals sets the warning levels a few degrees below each chip's own limit.");
        }
    }
}
