using System;
using System.Diagnostics;
using System.Windows;
using System.Windows.Interop;

namespace Vitals;

public partial class SettingsWindow : Window
{
    private readonly ConfigStore _store;
    private readonly Action _applied;
    private bool _loading;

    public SettingsWindow(ConfigStore store, Action applied)
    {
        _store = store;
        _applied = applied;
        InitializeComponent();
        Icon = IconArt.WindowIcon();
        SourceInitialized += (_, _) => Native.UseDarkTitleBar(new WindowInteropHelper(this).Handle);
        Load();

        StartWithWindows.Click += (_, _) => ChangeStartup();
        StartCollapsed.Checked += (_, _) => Change(c => c.StartExpanded = false);
        StartExpanded.Checked += (_, _) => Change(c => c.StartExpanded = true);
        AlwaysOnTop.Click += (_, _) => Change(c => c.AlwaysOnTop = AlwaysOnTop.IsChecked == true);
        LockPosition.Click += (_, _) => Change(c => c.LockPosition = LockPosition.IsChecked == true);
        SnapToCorners.Click += (_, _) => Change(c => c.SnapToCorners = SnapToCorners.IsChecked == true);
        OpacitySlider.ValueChanged += (_, _) => { OpacityValue.Text = $"{OpacitySlider.Value:0}%"; Change(c => c.Opacity = OpacitySlider.Value / 100); };
        OpenConfig.Click += (_, _) =>
        {
            try { Process.Start(new ProcessStartInfo(ConfigStore.FilePath) { UseShellExecute = true }); }
            catch { Process.Start(new ProcessStartInfo("notepad.exe", $"\"{ConfigStore.FilePath}\"") { UseShellExecute = true }); }
        };
    }

    /// <summary>Reloads the controls from config (also after config.json is edited by hand).</summary>
    public void Load()
    {
        _loading = true;
        var c = _store.Current;
        StartWithWindows.IsChecked = c.StartWithWindows;
        StartCollapsed.IsChecked = !c.StartExpanded;
        StartExpanded.IsChecked = c.StartExpanded;
        StartViewRow.IsEnabled = c.StartWithWindows;
        StartViewRow.Opacity = c.StartWithWindows ? 1 : 0.45;
        AlwaysOnTop.IsChecked = c.AlwaysOnTop;
        LockPosition.IsChecked = c.LockPosition;
        SnapToCorners.IsChecked = c.SnapToCorners;
        OpacitySlider.Value = Math.Round(c.Opacity * 100);
        OpacityValue.Text = $"{OpacitySlider.Value:0}%";
        _loading = false;
    }

    private void Change(Action<AppConfig> set)
    {
        if (_loading) return;
        set(_store.Current);
        _store.Save();
        _applied();
    }

    private async void ChangeStartup()
    {
        bool on = StartWithWindows.IsChecked == true;
        StartWithWindows.IsEnabled = false; // while Windows' admin prompt may be up
        var error = await System.Threading.Tasks.Task.Run(() => StartupTask.Set(on));
        StartWithWindows.IsEnabled = true;
        if (error != null)
        {
            StartWithWindows.IsChecked = !on;
            StartHint.Text = error;
            StartHint.Foreground = Theme.Warm;
            return;
        }
        StartHint.Text = "Run Vitals when you sign in.";
        StartHint.Foreground = (System.Windows.Media.Brush)FindResource("Dim");
        Change(c => c.StartWithWindows = on);
        StartViewRow.IsEnabled = on;
        StartViewRow.Opacity = on ? 1 : 0.45;
    }
}
