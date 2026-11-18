using System;
using System.Diagnostics;
using System.IO;
using System.Security;
using System.Security.Principal;
using System.Text;

namespace Vitals;

/// <summary>
/// "Start with Windows" is a Task Scheduler task that runs at sign-in with highest privileges, so Vitals starts as
/// administrator without a prompt. Creating or removing it needs Vitals to be running as administrator.
/// </summary>
internal static class StartupTask
{
    private const string Name = "Vitals";

    public static bool IsAdmin
    {
        get
        {
            using var id = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(id).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    public static bool Exists() => Run("/Query", "/TN", Name) == 0;

    /// <summary>
    /// Creates or removes the task. Returns an error message, or null when it worked. Without admin it starts an
    /// elevated copy of Vitals to do it (--set-startup), so changing the setting shows Windows' admin prompt once.
    /// </summary>
    public static string? Set(bool on)
    {
        if (!IsAdmin) return SetElevated(on);
        if (!on) return Exists() && Run("/Delete", "/TN", Name, "/F") != 0 ? "Couldn't remove the startup task." : null;

        string user = WindowsIdentity.GetCurrent().Name;
        string exe = Environment.ProcessPath ?? throw new InvalidOperationException("No exe path");
        string xml = $"""
            <?xml version="1.0" encoding="UTF-16"?>
            <Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
              <RegistrationInfo><Description>Starts Vitals when you sign in.</Description></RegistrationInfo>
              <Triggers>
                <LogonTrigger><Enabled>true</Enabled><UserId>{SecurityElement.Escape(user)}</UserId><Delay>PT5S</Delay></LogonTrigger>
              </Triggers>
              <Principals>
                <Principal id="Author"><UserId>{SecurityElement.Escape(user)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>HighestAvailable</RunLevel></Principal>
              </Principals>
              <Settings>
                <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
                <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
                <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
                <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
                <Priority>7</Priority>
              </Settings>
              <Actions Context="Author">
                <Exec><Command>{SecurityElement.Escape(exe)}</Command><Arguments>--startup</Arguments></Exec>
              </Actions>
            </Task>
            """;
        string file = Path.Combine(Path.GetTempPath(), "vitals-task.xml");
        File.WriteAllText(file, xml, Encoding.Unicode);
        try { return Run("/Create", "/TN", Name, "/XML", file, "/F") == 0 ? null : "Couldn't create the startup task."; }
        finally { File.Delete(file); }
    }

    private static string? SetElevated(bool on)
    {
        try
        {
            var psi = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true, Verb = "runas" };
            psi.ArgumentList.Add("--set-startup");
            psi.ArgumentList.Add(on ? "on" : "off");
            using var p = Process.Start(psi)!;
            if (!p.WaitForExit(60000)) return "Changing the startup task took too long.";
            return p.ExitCode == 0 ? null : on ? "Couldn't create the startup task." : "Couldn't remove the startup task.";
        }
        catch (System.ComponentModel.Win32Exception) { return "Changing this needs Windows' admin prompt, which was declined."; }
    }

    private static int Run(params string[] args)
    {
        var psi = new ProcessStartInfo("schtasks.exe") { CreateNoWindow = true, UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        foreach (var a in args) psi.ArgumentList.Add(a);
        using var p = Process.Start(psi)!;
        p.StandardOutput.ReadToEnd();
        p.StandardError.ReadToEnd();
        p.WaitForExit(10000);
        return p.ExitCode;
    }
}
