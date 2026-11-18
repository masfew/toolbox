using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Vitals;

public partial class App : Application
{
    private const string MutexName = @"Local\Vitals.SingleInstance";
    private const string ShowEventName = @"Local\Vitals.Show";
    private const string CloseEventName = @"Local\Vitals.Close";
    private const string InstallPidFile = "Vitals.install-pid"; // in %TEMP%; install.py writes it

    private ConfigStore? _store;
    private HardwareSampler? _hw;
    private SamplingLoop? _loop;
    private WidgetWindow? _widget;
    private TrayIcon? _tray;
    private SettingsWindow? _settings;
    private Mutex? _mutex;
    private EventWaitHandle? _showEvent;
    private EventWaitHandle? _closeEvent;

    // Arguments:
    //   --startup        started by the "Start with Windows" task: open collapsed or expanded as Settings says
    //   --no-elevate     don't ask for admin (CPU temperature stays off)
    //   --render <dir>   render the widget's views to PNGs and exit (for checking the look); no tray, no admin
    //   --demo           with --render: made-up readings and app names instead of this PC's (for the README's pictures)
    //   --make-icon <f>  write the app icon (.ico) and exit
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var args = e.Args;
        string? Arg(string name) { int i = Array.IndexOf(args, name); return i >= 0 && i + 1 < args.Length ? args[i + 1] : null; }
        bool Has(string name) => args.Contains(name);

        if (Arg("--make-icon") is string ico) { IconArt.WriteIco(ico); Shutdown(); return; }
        // Started elevated by Settings (StartupTask.Set without admin) only to create or remove the startup task.
        if (Arg("--set-startup") is string startup) { Shutdown(StartupTask.IsAdmin && StartupTask.Set(startup == "on") == null ? 0 : 1); return; }
        string? render = Arg("--render");

        if (render == null && AlreadyRunning()) { Shutdown(); return; }

        _store = new ConfigStore();
        _store.Load();

        bool wantAdmin = render == null && !StartupTask.IsAdmin && _store.Current.RunAsAdmin && !Has("--no-elevate") && !Has("--elevate-tried");
        if (wantAdmin && !PawnIoInstalled())
        {
            // Admin only adds the CPU temperature, which also needs the PawnIO driver, so don't prompt for nothing.
            wantAdmin = false;
            Log.Write("Not asking for admin: the PawnIO driver isn't installed, so admin wouldn't add the CPU temperature.");
        }
        if (wantAdmin)
        {
            try
            {
                var psi = new ProcessStartInfo(Environment.ProcessPath!) { UseShellExecute = true, Verb = "runas" };
                foreach (var a in args.Append("--elevate-tried")) psi.ArgumentList.Add(a);
                Process.Start(psi);
                Shutdown();
                return;
            }
            catch (Win32Exception) { Log.Write("Admin prompt declined; running without admin, so no CPU temperature."); }
        }

        if (render == null)
        {
            _mutex = new Mutex(true, MutexName, out bool created);
            if (!created) { Shutdown(); return; }
            _showEvent = new EventWaitHandle(false, EventResetMode.AutoReset, ShowEventName);
            var ev = _showEvent;
            new Thread(() => { while (ev.WaitOne()) Dispatcher.BeginInvoke(() => _widget?.ShowWidget()); }) { IsBackground = true, Name = "Vitals show signal" }.Start();
            // install.py sets this to close Vitals before replacing it, which stopping the process can't do when Vitals runs as admin.
            try
            {
                _closeEvent = Native.CreateUserSignalEvent(CloseEventName);
                var close = _closeEvent;
                new Thread(() => { if (close.WaitOne()) Dispatcher.BeginInvoke(() => { StartAgainAfterInstall(); Shutdown(); }); }) { IsBackground = true, Name = "Vitals close signal" }.Start();
            }
            catch (Exception ex) { Log.Write($"Couldn't set up the close signal for install.py: {ex.Message}"); }
        }

        _hw = new HardwareSampler();
        var store = _store;
        _loop = new SamplingLoop(_hw, () => store.Current);
        _widget = new WidgetWindow(store, _loop, () => store.Current.Warnings);
        _widget.SetExpanded(Has("--startup") ? store.Current.StartExpanded : store.Current.Expanded, remember: false);
        store.ReloadedFromDisk += () => Dispatcher.BeginInvoke(() => { _widget.ApplyConfig(); _settings?.Load(); });

        if (render != null) { _ = RenderViews(render, Has("--demo")); return; }

        _tray = new TrayIcon(() => _widget.IsVisible, () => _widget.Toggle(), OpenSettings, Shutdown);
        if (!Has("--hidden")) _widget.ShowWidget(); // --hidden: tray only (for measuring the idle cost)
        if (Has("--panel-open")) _widget.ForcePanel(true); // for measuring the per-app breakdown's cost

        // A few seconds in, once the CPU's TjMax has been read, check the warning levels fit this hardware.
        var warnings = new WarningLevels(store, _hw);
        Task.Delay(4000).ContinueWith(_ => warnings.CheckAsync());
        Log.Write($"Started ({(StartupTask.IsAdmin ? "admin" : "not admin")}). CPU: {_hw.CpuModel}. GPU: {_hw.GpuModel ?? "none"}.");
    }

    /// <summary>
    /// When install.py closes Vitals to update it, it leaves its process id in InstallPidFile. Vitals then starts a
    /// hidden PowerShell that waits for that install to end and starts Vitals again. That PowerShell has Vitals' own
    /// rights, so an admin Vitals comes back as admin with no prompt, which install.py can't do from a non-admin
    /// session (only admins may run the Start with Windows task). If the install fails, the old copy starts again.
    /// </summary>
    private static void StartAgainAfterInstall()
    {
        try
        {
            string file = Path.Combine(Path.GetTempPath(), InstallPidFile);
            if (!File.Exists(file)) return; // closed for an uninstall, or by something else: stay closed
            string text = File.ReadAllText(file).Trim();
            File.Delete(file);
            if (!int.TryParse(text, out int pid)) return;
            try { using var installer = Process.GetProcessById(pid); } catch (ArgumentException) { return; } // already gone
            string exe = Environment.ProcessPath!.Replace("'", "''");
            // --elevate-tried: come back with the rights it has now, without asking for admin again.
            string script = $"Wait-Process -Id {pid} -ErrorAction SilentlyContinue; Start-Process -FilePath '{exe}' -ArgumentList '--elevate-tried'";
            var psi = new ProcessStartInfo(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe")) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var a in new[] { "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script }) psi.ArgumentList.Add(a);
            using var _ = Process.Start(psi);
            Log.Write($"Closing for install.py (process {pid}); Vitals starts again when it ends.");
        }
        catch (Exception ex) { Log.Write($"Couldn't arrange to start again after the install: {ex.Message}"); }
    }

    /// <summary>Whether the PawnIO driver is installed, checked the way LibreHardwareMonitor does (its uninstall entry).</summary>
    private static bool PawnIoInstalled()
    {
        try
        {
            using var uninstall = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO");
            using var service = Microsoft.Win32.Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Services\PawnIO");
            return uninstall != null || service != null;
        }
        catch { return true; } // can't tell: ask for admin as before
    }

    /// <summary>If Vitals is already running, asks it to show the widget and returns true.</summary>
    private static bool AlreadyRunning()
    {
        try
        {
            if (!Mutex.TryOpenExisting(MutexName, out var m)) return false;
            m.Dispose();
        }
        catch (UnauthorizedAccessException) { /* exists, owned by the admin copy */ }
        try { using var ev = EventWaitHandle.OpenExisting(ShowEventName); ev.Set(); } catch { }
        return true;
    }

    private void OpenSettings()
    {
        if (_settings == null)
        {
            _settings = new SettingsWindow(_store!, () => _widget!.ApplyConfig());
            _settings.Closed += (_, _) => _settings = null;
            _settings.Show();
        }
        _settings.Activate();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _tray?.Dispose();
        _loop?.Dispose();
        _hw?.Dispose();
        _store?.Dispose();
        _showEvent?.Dispose();
        _closeEvent?.Dispose();
        try { _mutex?.ReleaseMutex(); } catch { }
        _mutex?.Dispose();
        base.OnExit(e);
    }

    // ---------- --render: PNGs of each view, for checking the look without a screen ----------

    /// <param name="demo">Show <see cref="DemoData"/> instead of reading this PC.</param>
    private async Task RenderViews(string dir, bool demo)
    {
        Directory.CreateDirectory(dir);
        var w = _widget!;
        w.Show(); // stays off-screen: it's only placed by ShowWidget
        w.SetExpanded(false, remember: false); // start collapsed whatever config.json says, and size the shown window
        // The demo's per-app lists are shown again after each ForcePanel, since the sampler that would refill them isn't running.
        void ShowDemoApps() { if (demo) w.ShowReading(DemoData.Last, DemoData.Apps); }
        if (demo) foreach (var reading in DemoData.Minute(_store!.Current.GraphHistorySeconds)) w.ShowReading(reading, null);
        else _loop!.Start();
        await Task.Delay(3500);
        Save(w, Path.Combine(dir, "collapsed.png"));
        w.ForcePanel(true);
        ShowDemoApps();
        await Task.Delay(2500);
        Save(w, Path.Combine(dir, "collapsed-hover.png"));
        w.SetExpanded(true, remember: false);
        w.ForcePanel(false);
        await Task.Delay(1200);
        Save(w, Path.Combine(dir, "expanded.png"));
        w.ForcePanel(true);
        ShowDemoApps();
        await Task.Delay(1200);
        Save(w, Path.Combine(dir, "expanded-hover.png"));

        var s = new SettingsWindow(_store!, () => { }) { Left = -32000, Top = -32000, WindowStartupLocation = WindowStartupLocation.Manual, ShowActivated = false };
        s.Show();
        await Task.Delay(300);
        SaveElement((FrameworkElement)s.Content, Path.Combine(dir, "settings.png"), Color.FromRgb(0x20, 0x20, 0x20));
        s.Close();

        foreach (int size in new[] { 16, 24, 32, 64 })
        {
            using var bmp = IconArt.Render(size);
            bmp.Save(Path.Combine(dir, $"icon-{size}.png"), System.Drawing.Imaging.ImageFormat.Png);
        }
        Shutdown();
    }

    private static void Save(WidgetWindow w, string file) => SaveElements(w.RenderParts(), file, Color.FromRgb(0x3A, 0x3D, 0x44));

    private static void SaveElement(FrameworkElement el, string file, Color background) => SaveElements(new[] { el }, file, background);

    /// <summary>Draws the elements stacked top to bottom (the panel's window over the card's) into one PNG.</summary>
    private static void SaveElements(FrameworkElement[] els, string file, Color background)
    {
        // Lay each part out at its own size: the off-screen windows apply a resize late, so their own layout can still
        // be the previous view's size and clip this one.
        foreach (var el in els)
        {
            el.Measure(new Size(double.IsNaN(el.Width) ? double.PositiveInfinity : el.Width, double.PositiveInfinity));
            el.Arrange(new Rect(el.DesiredSize));
        }
        const double scale = 2, pad = 10;
        double w = els.Max(e => e.ActualWidth), h = els.Sum(e => e.ActualHeight);
        var dv = new DrawingVisual();
        using (var dc = dv.RenderOpen())
        {
            dc.DrawRectangle(new SolidColorBrush(background), null, new Rect(0, 0, w + pad * 2, h + pad * 2));
            double y = pad;
            foreach (var el in els)
            {
                dc.DrawRectangle(new VisualBrush(el) { Stretch = Stretch.None, AlignmentX = AlignmentX.Left, AlignmentY = AlignmentY.Top }, null, new Rect(pad, y, el.ActualWidth, el.ActualHeight));
                y += el.ActualHeight;
            }
        }
        var bmp = new RenderTargetBitmap((int)Math.Ceiling((w + pad * 2) * scale), (int)Math.Ceiling((h + pad * 2) * scale), 96 * scale, 96 * scale, PixelFormats.Pbgra32);
        bmp.Render(dv);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(bmp));
        using var fs = File.Create(file);
        enc.Save(fs);
    }
}
