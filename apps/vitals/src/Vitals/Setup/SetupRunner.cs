using System;
using System.IO;
using System.Windows;

namespace Vitals.Setup;

/// <summary>
/// Vitals.exe --setup, which install.py runs from the build folder:
///   --setup                          the Setup window
///   --setup --quiet                  the same steps with no window (an update from a script or a Claude session)
///   --start-with-windows yes|no      the Options page's first box, or the quiet install's choice
///   --claude-levels yes|no           its second box, likewise
///   --setup-log &lt;file&gt;             appends what each step did, for install.py to print
///   --setup-test                     test mode (Installer.TestMode), for tests and recordings
/// Exit code: 0 installed, 1 failed, 2 cancelled.
/// </summary>
internal static class SetupRunner
{
    public static void Start(Application app, Func<string, string?> arg, Func<string, bool> has)
    {
        string? logFile = arg("--setup-log");
        void Log(string line)
        {
            if (logFile == null) return;
            try { File.AppendAllText(logFile, line + Environment.NewLine); } catch { }
        }
        bool? YesNo(string name) => arg(name) switch { "yes" => true, "no" => false, _ => null };
        bool testMode = has("--setup-test");
        var defaults = Installer.DefaultChoices(YesNo("--start-with-windows"), YesNo("--claude-levels"));

        if (has("--quiet"))
        {
            var installer = new Installer { TestMode = testMode, Log = Log };
            try
            {
                var check = ClaudeCheck.Run();
                Log(check.Message);
                installer.Run(defaults with { ClaudeLevels = check.Available && defaults.ClaudeLevels }, check.Available);
                // A quiet update leaves Vitals as it found it: running again if it was running.
                installer.Finish(startNow: installer.RestartsItself || installer.WasStopped);
                app.Shutdown(0);
            }
            catch (Exception ex)
            {
                Log("FAILED: " + (ex is SetupException ? ex.Message : $"Something went wrong: {ex.Message}"));
                app.Shutdown(1);
            }
            return;
        }

        var window = new SetupWindow(defaults, testMode, Log);
        window.Closed += (_, _) => app.Shutdown(window.Result);
        window.Show();
    }
}
