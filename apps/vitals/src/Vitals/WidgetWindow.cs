using System;
using System.Linq;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;
using Forms = System.Windows.Forms;

namespace Vitals;

/// <summary>
/// The widget. A transparent window anchored by its bottom-right corner, as tall as the expanded card, with the card at
/// its bottom (see WindowHeight). The per-app panel has a window of its own above it. Keeping the window small matters,
/// because Windows redraws the whole window area every second (a tall fixed-size window that also held the panel cost
/// ~2% of a core; hidden it costs nothing).
/// </summary>
public sealed class WidgetWindow : Window
{
    private const double CardWidth = 336;
    private const double EdgeGap = 10; // gap to the screen edge, in DIPs
    private static readonly Thickness CollapsedPadding = new(4, 7, 4, 7);

    private readonly ConfigStore _store;
    private readonly SamplingLoop _loop;
    private readonly Func<WarningConfig> _warnings;
    private AppConfig Cfg => _store.Current;

    private readonly Metric _cpu, _gpu, _ram, _vram;
    private readonly Metric[] _metrics;

    private readonly StackPanel _root = new() { VerticalAlignment = VerticalAlignment.Bottom, HorizontalAlignment = HorizontalAlignment.Right, Width = CardWidth };
    private readonly StackPanel _panelRoot = new() { Width = CardWidth };
    private readonly PanelWindow _panelWin;
    private readonly Border _panel, _bridge, _main;
    private readonly Grid _collapsed = new();
    private readonly StackPanel _expanded = new() { Margin = new Thickness(10, 3, 10, 3) };
    private readonly TextBlock _cpuTotal, _gpuTotal, _ramTotal, _vramTotal;
    private readonly StackPanel _cpuRows = new(), _gpuRows = new(), _ramRows = new(), _vramRows = new();

    private readonly DispatcherTimer _showTimer = new() { Interval = TimeSpan.FromMilliseconds(250) };
    private readonly DispatcherTimer _hideTimer = new() { Interval = TimeSpan.FromMilliseconds(150) };
    private readonly DispatcherTimer _hoverTimer = new() { Interval = TimeSpan.FromMilliseconds(50) };
    private bool _panelOpen, _pressed, _forcePanel, _hovering;
    private IntPtr _hwnd;
    private Snapshot? _last;

    public bool IsExpanded { get; private set; }

    public WidgetWindow(ConfigStore store, SamplingLoop loop, Func<WarningConfig> warnings)
    {
        _store = store;
        _loop = loop;
        _warnings = warnings;

        Title = "Vitals";
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ShowInTaskbar = false;
        ResizeMode = ResizeMode.NoResize;
        ShowActivated = false;
        Width = CardWidth;
        Left = -32000; Top = -32000;
        FontFamily = Theme.TextFont;
        Foreground = Theme.Text;
        TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
        UseLayoutRounding = true;

        int cap = HistoryLength();
        _cpu = new Metric("CPU", "%", Theme.CpuColor, cap);
        _gpu = new Metric("GPU", "%", Theme.GpuColor, cap);
        _ram = new Metric("RAM", "GB", Theme.RamColor, cap);
        _vram = new Metric("VRAM", "GB", Theme.VramColor, cap);
        _metrics = new[] { _cpu, _gpu, _ram, _vram };

        // per-app panel, top to bottom in the order of the readings (left to right collapsed, top to bottom expanded)
        var panelBody = new StackPanel();
        panelBody.Children.Add(Header("CPU BY APP", out _cpuTotal, 0));
        panelBody.Children.Add(_cpuRows);
        panelBody.Children.Add(Header("GPU BY APP", out _gpuTotal, 9));
        panelBody.Children.Add(_gpuRows);
        panelBody.Children.Add(Header("RAM BY APP", out _ramTotal, 9));
        panelBody.Children.Add(_ramRows);
        panelBody.Children.Add(Header("VRAM BY APP", out _vramTotal, 9));
        panelBody.Children.Add(_vramRows);
        _panel = Card(panelBody, new Thickness(12, 9, 12, 10));
        _panel.Opacity = 0;
        _panel.IsHitTestVisible = false;
        // a nearly invisible strip between panel and card, so moving the mouse up to the panel keeps it open
        _bridge = new Border { Height = 6, Background = new SolidColorBrush(Color.FromArgb(1, 0, 0, 0)) };
        _panelRoot.Children.Add(_panel);
        _panelRoot.Children.Add(_bridge);
        _panelWin = new PanelWindow(_panelRoot);

        BuildCollapsed();
        BuildExpanded();
        _main = Card(_collapsed, CollapsedPadding);
        _main.Cursor = Cursors.Hand;

        _root.Children.Add(_main);
        Content = _root;
        Height = 60;

        // Hover is judged from the cursor position, not WPF's MouseEnter and MouseLeave. The cursor crosses between two
        // windows (card and panel), and resizing a see-through window (expanding or collapsing) briefly leaves the old
        // picture in place, so Windows can report a MouseLeave under a still cursor. Acting on that once made the panel
        // close and reopen in a loop.
        MouseEventHandler enter = (_, _) => { if (!_hoverTimer.IsEnabled) _hoverTimer.Start(); SetHover(true); };
        _root.MouseEnter += enter;
        _panelRoot.MouseEnter += enter;
        _hoverTimer.Tick += (_, _) => CheckHover();
        _showTimer.Tick += (_, _) => { _showTimer.Stop(); SetPanel(true); };
        _hideTimer.Tick += (_, _) => { _hideTimer.Stop(); if (!_forcePanel) SetPanel(false); };

        _main.MouseLeftButtonDown += OnMainDown;
        _main.MouseLeftButtonUp += OnMainUp;

        SourceInitialized += (_, _) =>
        {
            _hwnd = new WindowInteropHelper(this).Handle;
            // Tool window: not in Alt+Tab. No-activate: clicking it never takes focus from what you're doing.
            long ex = (long)Native.GetWindowLongPtr(_hwnd, Native.GWL_EXSTYLE);
            Native.SetWindowLongPtr(_hwnd, Native.GWL_EXSTYLE, (IntPtr)(ex | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE));
        };
        DpiChanged += (_, _) => Dispatcher.BeginInvoke(PlaceAtSaved, DispatcherPriority.Background);
        // Follows drags and resizes. This runs inside the move's SetWindowPos, so it measures without running WPF's
        // pending layout; whatever changed the panel's rows (ApplyConfig) has run it already.
        LocationChanged += (_, _) => { if (_panelWin.IsVisible) PlacePanel(flushLayout: false); };
        _panelWin.DpiChanged += (_, _) => Dispatcher.BeginInvoke(() => PlacePanel(), DispatcherPriority.Background);

        _loop.Sampled += (snap, apps) => Dispatcher.BeginInvoke(() => Update(snap, apps));
        ApplyConfig();
    }

    // ---------- showing, hiding, config ----------

    public void ShowWidget()
    {
        if (!IsVisible) Show();
        PlaceAtSaved();
        if (_forcePanel) ForcePanel(true); // HideWidget closed it
        _loop.Start();
    }

    public void HideWidget()
    {
        _loop.Stop();
        _showTimer.Stop();
        _hideTimer.Stop();
        _hoverTimer.Stop();
        _hovering = false;
        _loop.WantApps = _forcePanel;
        SetPanel(false, animate: false);
        Hide();
    }

    public void Toggle() { if (IsVisible) HideWidget(); else ShowWidget(); }

    public void SetExpanded(bool expanded, bool remember = true)
    {
        IsExpanded = expanded;
        SetView(expanded);
        FitToContent(panelAfterFrame: expanded);
        if (remember && Cfg.Expanded != expanded) { Cfg.Expanded = expanded; _store.Save(); }
    }

    /// <summary>Applies settings that may have changed (from Settings or a hand edit of config.json).</summary>
    public void ApplyConfig()
    {
        Topmost = _panelWin.Topmost = Cfg.AlwaysOnTop;
        var card = Theme.Card(Cfg.Opacity);
        _panel.Background = card;
        _main.Background = card;
        int cap = HistoryLength();
        foreach (var m in _metrics) if (m.History.Capacity != cap) m.History.Resize(cap);
        EnsureRows();
        FitToContent();
        if (IsVisible) PlaceAtSaved();
        if (_panelWin.IsVisible) PlacePanel();
    }

    /// <summary>For the --render check: keeps the per-app panel open without hovering.</summary>
    public void ForcePanel(bool open) { _forcePanel = open; _loop.WantApps = open; SetPanel(open, animate: false); }

    /// <summary>For the --render check: what's showing, top to bottom (the panel, when open, then the card).</summary>
    public FrameworkElement[] RenderParts() => _panelOpen ? new FrameworkElement[] { _panelRoot, _root } : new FrameworkElement[] { _root };

    private int HistoryLength() => Math.Max(2, (int)Math.Round(Cfg.GraphHistorySeconds * 1000.0 / Cfg.UpdateIntervalMs));

    /// <summary>
    /// The height an element needs at the card's width, in DIPs. WPF's Measure does nothing when the element's own
    /// measure is still valid and the size offered matches its last one, even if a child changed underneath (swapping
    /// _main.Child only marks _main). The window lays the content out at its own height, so the first unbounded measure
    /// after that ran, but the next one, with no window resize in between, returned the old view's height. The window
    /// then kept the collapsed height showing the expanded view (only the VRAM row visible), or the expanded height
    /// showing the collapsed view (the per-app panel floating high above it). So: run the pending layout first, which
    /// measures every changed element and passes size changes up to its parents, then measure this one afresh.
    /// </summary>
    private static double NeededHeight(UIElement e, bool flushLayout = true)
    {
        if (flushLayout) e.UpdateLayout();
        e.InvalidateMeasure();
        e.Measure(new Size(CardWidth, double.PositiveInfinity));
        return Math.Ceiling(e.DesiredSize.Height);
    }

    /// <summary>
    /// The window's height in DIPs: the taller of the two views (the expanded one), whichever is showing. The card sits
    /// at the window's bottom, with see-through space above it while collapsed (clicks pass through it). Expanding or
    /// collapsing then redraws the window without resizing it. A resize that moves the window's top shows the old
    /// picture at the new top for one frame, so the collapsed card jumped up and its place went empty on every expand
    /// (recorded at 60 fps, 14 Nov 2026). The other view is measured by swapping it in and back out; nothing renders
    /// in between.
    /// </summary>
    private double WindowHeight()
    {
        double now = NeededHeight(_root);
        UIElement child = _main.Child;
        Thickness pad = _main.Padding;
        bool expanded = child == _expanded;
        SetView(!expanded);
        double other = NeededHeight(_root);
        _main.Child = child;
        _main.Padding = pad;
        NeededHeight(_root); // leave the showing view measured, for CardTop
        return Math.Max(now, other);
    }

    private void SetView(bool expanded)
    {
        _main.Child = expanded ? _expanded : _collapsed;
        _main.Padding = expanded ? new Thickness(0) : CollapsedPadding;
    }

    /// <summary>The card's top edge on screen, in pixels: the window's bottom less the card's height.</summary>
    private int CardTop(Native.RECT r, double scale) => r.Bottom - (int)Math.Ceiling(_root.DesiredSize.Height * scale);

    /// <summary>
    /// Resizes the window to fit the expanded view, keeping its bottom-right corner where it is (one atomic move), and
    /// puts the panel back on the card's top. The panel's window moves at once, but the card's new view shows a frame
    /// or two later. Moving the panel up first on expand left a gap between them for that frame, so on expand the panel
    /// moves once the card has drawn (panelAfterFrame), briefly overlapping its top instead. On collapse moving first
    /// is the overlapping order.
    /// </summary>
    private void FitToContent(bool panelAfterFrame = false)
    {
        double hDip = WindowHeight();
        if (_hwnd == IntPtr.Zero || !IsVisible) { Height = hDip; return; }
        double s = Native.GetDpiForWindow(_hwnd) / 96.0;
        Native.GetWindowRect(_hwnd, out var r);
        int w = r.Right - r.Left, h = (int)Math.Ceiling(hDip * s);
        if (h != r.Bottom - r.Top)
            Native.SetWindowPos(_hwnd, IntPtr.Zero, r.Right - w, r.Bottom - h, w, h, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
        // the card's top moves on expand and collapse even when the window doesn't
        if (!_panelWin.IsVisible) return;
        if (panelAfterFrame) AfterNextFrame(() => { if (_panelWin.IsVisible) PlacePanel(); });
        else PlacePanel();
    }

    /// <summary>Runs an action on the second render tick from now, by when the first tick's frame is on screen.</summary>
    private static void AfterNextFrame(Action action)
    {
        int ticks = 0;
        EventHandler? tick = null;
        tick = (_, _) =>
        {
            if (++ticks < 2) return;
            CompositionTarget.Rendering -= tick;
            action();
        };
        CompositionTarget.Rendering += tick;
    }

    /// <summary>
    /// Puts the panel's window right above the card (or below it, when the card sits too near the top of its screen),
    /// the card's width and as tall as the panel. The bridge strip goes on the side that touches the card.
    /// </summary>
    private void PlacePanel(bool flushLayout = true)
    {
        if (_hwnd == IntPtr.Zero) return;
        IntPtr ph = _panelWin.Handle;
        if (_panelWin.Owner == null && IsVisible) _panelWin.Owner = this; // stays above the card, hides with it
        double s = Native.GetDpiForWindow(_hwnd) / 96.0;
        Native.GetWindowRect(_hwnd, out var r);
        r.Top = CardTop(r, s); // the window reaches above a collapsed card
        int w = r.Right - r.Left, h = (int)Math.Ceiling(NeededHeight(_panelRoot, flushLayout) * s);
        var wa = Forms.Screen.FromPoint(new System.Drawing.Point((r.Left + r.Right) / 2, (r.Top + r.Bottom) / 2)).WorkingArea;
        bool below = r.Top - h < wa.Top;
        if ((_panelRoot.Children[0] == _bridge) != below)
        {
            _panelRoot.Children.Clear();
            _panelRoot.Children.Add(below ? _bridge : _panel);
            _panelRoot.Children.Add(below ? _panel : _bridge);
        }
        int y = below ? r.Bottom : r.Top - h;
        Native.GetWindowRect(ph, out var pr);
        if (pr.Left == r.Left && pr.Top == y && pr.Right - pr.Left == w && pr.Bottom - pr.Top == h) return;
        Native.SetWindowPos(ph, IntPtr.Zero, r.Left, y, w, h, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
    }

    // ---------- placement ----------

    private void PlaceAtSaved()
    {
        if (_hwnd == IntPtr.Zero) return;
        var pos = Cfg.Position;
        if (pos == null || !Forms.Screen.AllScreens.Any(s => s.WorkingArea.Contains(pos.Right - 2, pos.Bottom - 2)))
        {
            // Default: bottom-right of the right-most screen.
            var wa = Forms.Screen.AllScreens.OrderByDescending(s => s.Bounds.Right).First().WorkingArea;
            double s = Native.DpiForPoint(wa.Right - 1, wa.Bottom - 1) / 96.0;
            pos = new WidgetPosition { Right = wa.Right - (int)(EdgeGap * s), Bottom = wa.Bottom - (int)(EdgeGap * s) };
        }
        double scale = Native.DpiForPoint(pos.Right - 1, pos.Bottom - 1) / 96.0;
        int w = (int)Math.Ceiling(CardWidth * scale);
        int h = (int)Math.Ceiling(WindowHeight() * scale);
        Native.SetWindowPos(_hwnd, IntPtr.Zero, pos.Right - w, pos.Bottom - h, w, h, Native.SWP_NOZORDER | Native.SWP_NOACTIVATE);
    }

    private void OnMainDown(object sender, MouseButtonEventArgs e)
    {
        if (Cfg.LockPosition) { _pressed = true; e.Handled = true; return; }
        Native.GetWindowRect(_hwnd, out var before);
        try { DragMove(); } catch (InvalidOperationException) { }
        Native.GetWindowRect(_hwnd, out var after);
        if (Math.Abs(after.Left - before.Left) + Math.Abs(after.Top - before.Top) < 4) { SetExpanded(!IsExpanded); return; }
        SnapAndSave(after);
        e.Handled = true;
    }

    private void OnMainUp(object sender, MouseButtonEventArgs e)
    {
        if (!_pressed) return;
        _pressed = false;
        SetExpanded(!IsExpanded);
    }

    private void SnapAndSave(Native.RECT r)
    {
        double s = Native.GetDpiForWindow(_hwnd) / 96.0;
        int right = r.Right, bottom = r.Bottom;
        if (Cfg.SnapToCorners)
        {
            int cardH = (int)Math.Round(_main.ActualHeight * s), width = r.Right - r.Left;
            var wa = Forms.Screen.FromPoint(new System.Drawing.Point((r.Left + r.Right) / 2, r.Bottom - cardH / 2)).WorkingArea;
            int m = (int)(EdgeGap * s), near = (int)(40 * s) + m;
            if (Math.Abs(wa.Right - right) < near) right = wa.Right - m;
            else if (Math.Abs(r.Left - wa.Left) < near) right = wa.Left + m + width;
            if (Math.Abs(wa.Bottom - bottom) < near) bottom = wa.Bottom - m;
            else if (Math.Abs(bottom - cardH - wa.Top) < near) bottom = wa.Top + m + cardH;
        }
        Cfg.Position = new WidgetPosition { Right = right, Bottom = bottom };
        _store.Save();
        PlaceAtSaved();
    }

    // ---------- hover panel ----------

    /// <summary>Runs every 50 ms while the cursor is over the widget or the panel is open, and stops once neither is.</summary>
    private void CheckHover()
    {
        bool inside = _hwnd != IntPtr.Zero && IsVisible && CursorOverWindow();
        SetHover(inside);
        if (!inside && (!_panelOpen || _forcePanel)) _hoverTimer.Stop();
    }

    /// <summary>Over the card, or over the panel while it's showing.</summary>
    private bool CursorOverWindow()
    {
        if (!Native.GetCursorPos(out var p)) return false;
        return OverUncovered(_hwnd, p, card: true) || (_panelWin.IsVisible && OverUncovered(_panelWin.Handle, p));
    }

    /// <summary>
    /// The panel's window is sized to exactly what it shows, and the card is the bottom of its window (the space above
    /// a collapsed card is see-through), so those rectangles are the hover area, unless a window above (the tray menu,
    /// Settings, another app) covers the cursor. A window below it under the cursor is the resize glitch, so it still
    /// counts as over the widget.
    /// </summary>
    private bool OverUncovered(IntPtr hwnd, Native.POINT p, bool card = false)
    {
        if (!Native.GetWindowRect(hwnd, out var r)) return false;
        if (card) r.Top = CardTop(r, Native.GetDpiForWindow(hwnd) / 96.0);
        if (p.X < r.Left || p.X >= r.Right || p.Y < r.Top || p.Y >= r.Bottom) return false;
        IntPtr top = Native.GetAncestor(Native.WindowFromPoint(p), Native.GA_ROOT);
        if (top == IntPtr.Zero || top == _hwnd || top == _panelWin.Handle) return true;
        for (IntPtr w = Native.GetWindow(hwnd, Native.GW_HWNDPREV), n = 0; w != IntPtr.Zero && n < 5000; w = Native.GetWindow(w, Native.GW_HWNDPREV), n++)
            if (w == top) return false;
        return true;
    }

    private void SetHover(bool on)
    {
        if (on == _hovering) return;
        _hovering = on;
        if (on)
        {
            _hideTimer.Stop();
            _loop.WantApps = true;
            if (!_panelOpen) _showTimer.Start();
        }
        else
        {
            _showTimer.Stop();
            if (_panelOpen) _hideTimer.Start();
            else if (!_forcePanel) _loop.WantApps = false;
        }
    }

    private void SetPanel(bool open, bool animate = true)
    {
        // (open and already open goes on only to show a panel that was opened while the card was hidden)
        if (open == _panelOpen && !(open && IsVisible && !_panelWin.IsVisible)) return;
        _panelOpen = open;
        if (!open) _loop.WantApps = _forcePanel;
        _panel.IsHitTestVisible = open;
        // The panel has its own window, shown and hidden but never resized while hovering: resizing a see-through
        // window shows its old picture at the new size for a frame, which flickered the card on every open and close.
        if (open && !_panelWin.IsVisible && IsVisible) // never without the card (--hidden --panel-open)
        {
            PlacePanel();
            _panelWin.Show();
            PlacePanel();
        }
        void Collapse()
        {
            if (_panelOpen) return;
            _panelWin.Hide();
        }
        if (!animate)
        {
            _panel.BeginAnimation(OpacityProperty, null);
            _panel.Opacity = open ? 1 : 0;
            if (!open) Collapse();
            return;
        }
        var anim = new DoubleAnimation(open ? 1 : 0, TimeSpan.FromMilliseconds(150));
        if (!open) anim.Completed += (_, _) => Collapse();
        _panel.BeginAnimation(OpacityProperty, anim);
    }

    // ---------- updates ----------

    /// <summary>Shows a reading that didn't come from the sampler (<see cref="DemoData"/>).</summary>
    public void ShowReading(Snapshot s, AppUsage? apps) => Update(s, apps);

    private void Update(Snapshot s, AppUsage? apps)
    {
        _last = s;
        var w = _warnings();

        _cpu.Push(s.CpuLoad, s.CpuLoad / 100, $"{s.CpuLoad:0}", 100);
        _cpu.SetSub(s.CpuTemp is double ct ? $"{ct:0}°C" : "—", TempLevel(s.CpuTemp, w.Cpu));

        if (s.GpuLoad is double gl)
        {
            _gpu.Push(gl, gl / 100, $"{gl:0}", 100);
            _gpu.SetSub(s.GpuTemp is double gt ? $"{gt:0}°C" : "—", TempLevel(s.GpuTemp, w.Gpu));
        }
        else { _gpu.Missing(); _gpu.SetSub("—", 0); }

        _ram.Push(s.RamUsedGB, s.RamUsedGB / s.RamTotalGB, $"{s.RamUsedGB:0.0}", s.RamTotalGB);
        _ram.SetSub($"of {Math.Round(s.RamTotalGB):0} GB", -1);

        if (s.VramUsedGB is double vu && s.VramTotalGB is double vt && vt > 0)
        {
            double f = vu / vt;
            _vram.Push(vu, f, $"{vu:0.0}", vt);
            _vram.SetSub($"of {Math.Round(vt):0} GB", -1);
            _vram.SetValueLevel(f >= w.Vram.Red ? 2 : f >= w.Vram.Amber ? 1 : 0);
        }
        else { _vram.Missing(); _vram.SetSub("—", -1); }

        if (apps != null) UpdateApps(s, apps);
    }

    private static int TempLevel(double? t, TempWarning? w) => t is double v && w != null ? (v >= w.Red ? 2 : v >= w.Amber ? 1 : 0) : 0;

    private void UpdateApps(Snapshot s, AppUsage apps)
    {
        _cpuTotal.Text = $"{s.CpuLoad:0}%";
        _gpuTotal.Text = s.GpuLoad is double gl ? $"{gl:0}%" : "";
        _ramTotal.Text = $"{s.RamUsedGB:0.0} / {Math.Round(s.RamTotalGB):0} GB";
        _vramTotal.Text = s.VramUsedGB is double vu && s.VramTotalGB is double vt ? $"{vu:0.0} / {Math.Round(vt):0} GB" : "";
        // CPU and GPU bars show each app's share of the whole chip, so a full bar is 100%.
        FillRows(_cpuRows, apps.Cpu, 100, FormatPercent);
        FillRows(_gpuRows, apps.Gpu, 100, FormatPercent);
        FillRows(_ramRows, apps.Ram, s.RamUsedGB, FormatSize);
        FillRows(_vramRows, apps.Vram, s.VramUsedGB ?? apps.Vram.Sum(a => a.Value), FormatSize);
    }

    /// <summary>
    /// Keeps appsListed rows in each list, empty until data comes, so the panel is its full height before it first
    /// opens: growing its window while it shows would flash, as any resize of a see-through window does.
    /// </summary>
    private void EnsureRows()
    {
        foreach (var (host, color) in new[] { (_cpuRows, Theme.CpuColor), (_gpuRows, Theme.GpuColor), (_ramRows, Theme.RamColor), (_vramRows, Theme.VramColor) })
        {
            while (host.Children.Count < Cfg.AppsListed) host.Children.Add(new AppRowView(color));
            while (host.Children.Count > Cfg.AppsListed) host.Children.RemoveAt(host.Children.Count - 1);
        }
    }

    private void FillRows(StackPanel host, AppRow[] rows, double total, Func<double, string> format)
    {
        EnsureRows();
        for (int i = 0; i < host.Children.Count; i++)
        {
            var view = (AppRowView)host.Children[i];
            if (i < rows.Length) view.Set(rows[i].Name, total > 0 ? rows[i].Value / total : 0, format(rows[i].Value));
            else view.Set("", 0, "");
        }
    }

    private static string FormatSize(double gb) => gb >= 1 ? $"{gb:0.0} GB" : $"{gb * 1024:0} MB";

    private static string FormatPercent(double p) => p >= 10 ? $"{p:0}%" : $"{p:0.0}%";

    // ---------- building the views ----------

    private void BuildCollapsed()
    {
        for (int i = 0; i < 4; i++) _collapsed.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        for (int i = 0; i < 4; i++)
        {
            var m = _metrics[i];
            var cell = new StackPanel { Orientation = Orientation.Horizontal, HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
            m.SmallRing.Width = m.SmallRing.Height = 26;
            m.SmallRing.Margin = new Thickness(0, 0, 7, 0);
            cell.Children.Add(m.SmallRing);
            var text = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
            text.Children.Add(m.SmallLabel);
            text.Children.Add(m.SmallValue);
            cell.Children.Add(text);
            var holder = new Border { Child = cell, BorderBrush = Theme.Line, BorderThickness = new Thickness(i == 0 ? 0 : 1, 0, 0, 0) };
            Grid.SetColumn(holder, i);
            _collapsed.Children.Add(holder);
        }
    }

    private void BuildExpanded()
    {
        for (int i = 0; i < 4; i++)
        {
            var m = _metrics[i];
            var row = new Grid { Height = 40 };
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(30) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(52) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            row.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(74) });
            m.RowRing.Width = m.RowRing.Height = 30;
            m.RowRing.Thickness = 4;
            row.Children.Add(m.RowRing);
            var label = new StackPanel { VerticalAlignment = VerticalAlignment.Center, Margin = new Thickness(10, 0, 0, 0) };
            label.Children.Add(m.RowLabel);
            label.Children.Add(m.RowSub);
            Grid.SetColumn(label, 1);
            row.Children.Add(label);
            m.Spark.Height = 24;
            m.Spark.Margin = new Thickness(0, 0, 10, 0);
            Grid.SetColumn(m.Spark, 2);
            row.Children.Add(m.Spark);
            Grid.SetColumn(m.RowValue, 3);
            row.Children.Add(m.RowValue);
            _expanded.Children.Add(new Border { Child = row, BorderBrush = Theme.Line, BorderThickness = new Thickness(0, i == 0 ? 0 : 1, 0, 0) });
        }
    }

    private static Border Card(UIElement child, Thickness padding) => new()
    {
        Child = child,
        Padding = padding,
        CornerRadius = new CornerRadius(10),
        BorderBrush = Theme.Line,
        BorderThickness = new Thickness(1),
    };

    private static Grid Header(string title, out TextBlock total, double top)
    {
        var g = new Grid { Margin = new Thickness(0, top, 0, 5) };
        g.Children.Add(new TextBlock { Text = title, FontSize = 10, FontWeight = FontWeights.SemiBold, Foreground = Theme.Dim });
        total = new TextBlock { FontSize = 10, Foreground = Theme.Faint, HorizontalAlignment = HorizontalAlignment.Right };
        g.Children.Add(total);
        return g;
    }

    /// <summary>One reading's pieces in both views.</summary>
    private sealed class Metric
    {
        public readonly Ring SmallRing, RowRing;
        public readonly TextBlock SmallLabel, SmallValue, RowLabel, RowSub, RowValue;
        public readonly Sparkline Spark;
        public readonly History History;
        private readonly Run _smallNum, _rowNum;
        private readonly string _unit;

        public Metric(string name, string unit, Color color, int historyLength)
        {
            _unit = unit;
            History = new History(historyLength);
            var brush = Theme.Solid(color);
            SmallRing = new Ring { Brush = brush, Thickness = 3.5 };
            RowRing = new Ring { Brush = brush, Thickness = 4 };
            Spark = new Sparkline { Color = color };

            SmallLabel = new TextBlock { Text = name, FontSize = 10, FontWeight = FontWeights.SemiBold, Foreground = Theme.Dim };
            _smallNum = new Run("—") { FontSize = 14, FontWeight = FontWeights.SemiBold, FontFamily = Theme.DisplayFont };
            SmallValue = new TextBlock { LineHeight = 17 };
            SmallValue.Inlines.Add(_smallNum);
            SmallValue.Inlines.Add(new Run(unit) { FontSize = 10, Foreground = Theme.Dim, FontWeight = FontWeights.Medium });

            RowLabel = new TextBlock { Text = name, FontSize = 11, FontWeight = FontWeights.SemiBold, Foreground = Theme.Dim };
            RowSub = new TextBlock { FontSize = 11, Foreground = Theme.Text, Margin = new Thickness(0, 1, 0, 0) };
            _rowNum = new Run("—") { FontSize = 16, FontWeight = FontWeights.SemiBold, FontFamily = Theme.DisplayFont };
            RowValue = new TextBlock { HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
            RowValue.Inlines.Add(_rowNum);
            RowValue.Inlines.Add(new Run(" " + unit) { FontSize = 11, Foreground = Theme.Dim, FontWeight = FontWeights.Medium });
        }

        public void Push(double value, double fraction, string text, double max)
        {
            History.Add(value);
            SmallRing.Value = RowRing.Value = fraction;
            _smallNum.Text = _rowNum.Text = text;
            Spark.Set(History.ToArray(), max, History.Capacity);
        }

        public void Missing()
        {
            SmallRing.Value = RowRing.Value = 0;
            _smallNum.Text = _rowNum.Text = "—";
        }

        /// <summary>Level 0 normal, 1 amber, 2 red; -1 shows the sub line faint (for "of 64 GB").</summary>
        public void SetSub(string text, int level)
        {
            RowSub.Text = text;
            RowSub.Foreground = level switch { 2 => Theme.Hot, 1 => Theme.Warm, -1 => Theme.Faint, _ => Theme.Text };
            // The collapsed view has no temperature, so its label carries the warning colour.
            if (level >= 0) SmallLabel.Foreground = level switch { 2 => Theme.Hot, 1 => Theme.Warm, _ => Theme.Dim };
        }

        public void SetValueLevel(int level)
        {
            var b = level switch { 2 => Theme.Hot, 1 => Theme.Warm, _ => Theme.Text };
            _smallNum.Foreground = _rowNum.Foreground = b;
        }
    }

    /// <summary>The per-app panel's own see-through window, placed right above the card's window.</summary>
    private sealed class PanelWindow : Window
    {
        private IntPtr _handle;

        public PanelWindow(UIElement content)
        {
            Title = "Vitals panel";
            WindowStyle = WindowStyle.None;
            AllowsTransparency = true;
            Background = Brushes.Transparent;
            ShowInTaskbar = false;
            ResizeMode = ResizeMode.NoResize;
            ShowActivated = false;
            Width = CardWidth;
            Left = -32000; Top = -32000;
            FontFamily = Theme.TextFont;
            Foreground = Theme.Text;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            UseLayoutRounding = true;
            Content = content;
        }

        /// <summary>The window's handle, made on first use so it can be placed before it's shown.</summary>
        public IntPtr Handle
        {
            get
            {
                if (_handle != IntPtr.Zero) return _handle;
                _handle = new WindowInteropHelper(this).EnsureHandle();
                long ex = (long)Native.GetWindowLongPtr(_handle, Native.GWL_EXSTYLE);
                Native.SetWindowLongPtr(_handle, Native.GWL_EXSTYLE, (IntPtr)(ex | Native.WS_EX_TOOLWINDOW | Native.WS_EX_NOACTIVATE));
                return _handle;
            }
        }
    }

    /// <summary>One app in the per-app panel: its name over a bar showing its share, and its size.</summary>
    private sealed class AppRowView : Grid
    {
        private readonly TextBlock _name = new() { FontSize = 12, Padding = new Thickness(6, 1, 6, 1), TextTrimming = TextTrimming.CharacterEllipsis, VerticalAlignment = VerticalAlignment.Center };
        private readonly TextBlock _size = new() { FontSize = 12, Foreground = Theme.Dim, HorizontalAlignment = HorizontalAlignment.Right, VerticalAlignment = VerticalAlignment.Center };
        private readonly ColumnDefinition _fill = new(), _rest = new();

        public AppRowView(Color color)
        {
            Height = 20;
            ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
            ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(62) });

            var bar = new Grid { Margin = new Thickness(0, 1, 0, 1) };
            bar.ColumnDefinitions.Add(_fill);
            bar.ColumnDefinitions.Add(_rest);
            var clip = new Border { CornerRadius = new CornerRadius(4), Background = Theme.RowBack, Child = bar };
            var fill = new Border { Background = Theme.WithAlpha(color, 0x42), CornerRadius = new CornerRadius(4, 0, 0, 4) };
            bar.Children.Add(fill);
            Children.Add(clip);
            Children.Add(_name);
            Grid.SetColumn(_size, 1);
            Children.Add(_size);
        }

        public void Set(string name, double fraction, string size)
        {
            _name.Text = name;
            _size.Text = size;
            double f = Math.Clamp(fraction, 0, 1);
            _fill.Width = new GridLength(f, GridUnitType.Star);
            _rest.Width = new GridLength(1 - f, GridUnitType.Star);
        }
    }
}
