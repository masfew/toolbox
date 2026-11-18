using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media.Imaging;
using Forms = System.Windows.Forms;
using Media = System.Windows.Media;

namespace Vitals;

/// <summary>The four-part ring: CPU top-right, GPU bottom-right, RAM bottom-left, VRAM top-left, with even gaps.</summary>
internal static class IconArt
{
    private static readonly Color[] Colors =
    {
        Color.FromArgb(0x4C, 0xC2, 0xFF), Color.FromArgb(0x7F, 0xDC, 0x6F),
        Color.FromArgb(0xC4, 0x9B, 0xFF), Color.FromArgb(0xFF, 0xB4, 0x54),
    };

    public static Bitmap Render(int size)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(Color.Transparent);
        float s = size / 16f;
        // Drawn on a 16-unit grid: outer radius 6.9, inner 4.3, and straight cuts 1.6 wide so each gap is even.
        const float R = 6.9f, r = 4.3f, h = 0.8f, c = 8f;
        double outerStart = -Math.Acos(h / R) * 180 / Math.PI, outerEnd = -Math.Asin(h / R) * 180 / Math.PI;
        double innerStart = -Math.Asin(h / r) * 180 / Math.PI, innerEnd = -Math.Acos(h / r) * 180 / Math.PI;
        for (int i = 0; i < 4; i++)
        {
            using var path = new GraphicsPath();
            path.AddArc((c - R) * s, (c - R) * s, 2 * R * s, 2 * R * s, (float)outerStart, (float)(outerEnd - outerStart));
            path.AddArc((c - r) * s, (c - r) * s, 2 * r * s, 2 * r * s, (float)innerStart, (float)(innerEnd - innerStart));
            path.CloseFigure();
            using var m = new Matrix();
            m.RotateAt(90 * i, new PointF(c * s, c * s));
            path.Transform(m);
            using var brush = new SolidBrush(Colors[i]);
            g.FillPath(brush, path);
        }
        return bmp;
    }

    public static Icon TrayIcon()
    {
        int size = Forms.SystemInformation.SmallIconSize.Width;
        using var bmp = Render(size);
        IntPtr h = bmp.GetHicon();
        using var temp = Icon.FromHandle(h);
        var icon = (Icon)temp.Clone();
        Native.DestroyIcon(h);
        return icon;
    }

    public static BitmapSource WindowIcon() => Image(32);

    /// <summary>The icon as a WPF image of the given size.</summary>
    public static BitmapSource Image(int size)
    {
        using var bmp = Render(size);
        using var ms = new MemoryStream();
        bmp.Save(ms, ImageFormat.Png);
        ms.Position = 0;
        var frame = BitmapFrame.Create(ms, BitmapCreateOptions.None, BitmapCacheOption.OnLoad);
        frame.Freeze();
        return frame;
    }

    /// <summary>Writes a multi-size .ico (PNG frames). Used once to make vitals.ico: Vitals.exe --make-icon path.</summary>
    public static void WriteIco(string path)
    {
        int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 256 };
        var images = new byte[sizes.Length][];
        for (int i = 0; i < sizes.Length; i++)
        {
            using var bmp = Render(sizes[i]);
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            images[i] = ms.ToArray();
        }
        using var fs = File.Create(path);
        using var w = new BinaryWriter(fs);
        w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);
        int offset = 6 + 16 * sizes.Length;
        for (int i = 0; i < sizes.Length; i++)
        {
            w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
            w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));
            w.Write((byte)0); w.Write((byte)0);
            w.Write((short)1); w.Write((short)32);
            w.Write(images[i].Length); w.Write(offset);
            offset += images[i].Length;
        }
        foreach (var img in images) w.Write(img);
    }
}

/// <summary>The tray icon: a left or right click opens the menu (Hide or Show widget, Settings, Close).</summary>
internal sealed class TrayIcon : IDisposable
{
    private readonly Forms.NotifyIcon _icon;
    private readonly TrayMenu _menu;

    public TrayIcon(Func<bool> widgetShown, Action toggle, Action settings, Action close)
    {
        _menu = new TrayMenu(widgetShown, toggle, settings, close);
        _icon = new Forms.NotifyIcon { Icon = IconArt.TrayIcon(), Text = "Vitals", Visible = true };
        // Decide on the press whether the release opens the menu: a press while the menu is open (or that just closed
        // it) closes it. Windows 11's tray seems to report the press only along with the release, so a press held
        // longer than JustClosed's 400 ms still reopens the menu (tested 14 Nov 2026).
        bool openOnUp = true;
        _icon.MouseDown += (_, _) => openOnUp = !_menu.IsVisible && !_menu.JustClosed;
        _icon.MouseUp += (_, e) =>
        {
            bool open = openOnUp;
            openOnUp = true;
            if (e.Button is not (Forms.MouseButtons.Left or Forms.MouseButtons.Right)) return;
            if (open) _menu.ShowAtCursor();
            else if (_menu.IsVisible) _menu.HideMenu(); // the press didn't take focus from it, so close it here
        };
    }

    public void Dispose()
    {
        _icon.Visible = false;
        _icon.Dispose();
        _menu.Close();
    }
}

/// <summary>A small dark menu in the Windows 11 style.</summary>
internal sealed class TrayMenu : Window
{
    private readonly Func<bool> _widgetShown;
    private readonly TextBlock _toggleGlyph, _toggleText;
    private long _closedAt = long.MinValue / 2;
    private bool _selfHiding;

    /// <summary>True just after the menu lost focus, which is what pressing the tray icon does to an open menu.</summary>
    public bool JustClosed => Environment.TickCount64 - _closedAt < 400;

    public TrayMenu(Func<bool> widgetShown, Action toggle, Action settings, Action close)
    {
        _widgetShown = widgetShown;
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Media.Brushes.Transparent;
        ShowInTaskbar = false;
        Topmost = true;
        ResizeMode = ResizeMode.NoResize;
        SizeToContent = SizeToContent.WidthAndHeight;
        FontFamily = Theme.TextFont;
        Foreground = Theme.Text;
        Left = -32000; Top = -32000;

        var list = new StackPanel();
        list.Children.Add(Item("", "Hide widget", toggle, out _toggleGlyph, out _toggleText));
        list.Children.Add(Item("", "Settings", settings, out _, out _));
        list.Children.Add(Item("", "Close", close, out _, out _));
        Content = new Border
        {
            Child = list,
            Width = 200,
            Padding = new Thickness(4),
            CornerRadius = new CornerRadius(8),
            Background = new Media.SolidColorBrush(Media.Color.FromArgb(0xF7, 0x2C, 0x2C, 0x2E)),
            BorderBrush = new Media.SolidColorBrush(Media.Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF)),
            BorderThickness = new Thickness(1),
        };
        // Clicking the tray icon while the menu is open deactivates it on mouse-down, before the icon's mouse-up.
        // Remember when, so that click closes the menu instead of reopening it.
        // Only a click elsewhere counts: the menu's own Hide (Esc, an item) also deactivates it, and must not swallow
        // a quick next click on the icon.
        Deactivated += (_, _) => { if (!_selfHiding) _closedAt = Environment.TickCount64; Hide(); };
        KeyDown += (_, e) => { if (e.Key == Key.Escape) HideMenu(); };
    }

    private Border Item(string glyph, string text, Action action, out TextBlock glyphBlock, out TextBlock textBlock)
    {
        var row = new StackPanel { Orientation = Orientation.Horizontal, VerticalAlignment = VerticalAlignment.Center };
        glyphBlock = new TextBlock { Text = glyph, FontFamily = Theme.IconFont, FontSize = 13, Width = 16, Foreground = Theme.Dim, TextAlignment = TextAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
        textBlock = new TextBlock { Text = text, FontSize = 13, Margin = new Thickness(12, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        row.Children.Add(glyphBlock);
        row.Children.Add(textBlock);
        var b = new Border { Child = row, Height = 32, Padding = new Thickness(10, 0, 10, 0), CornerRadius = new CornerRadius(4), Background = Media.Brushes.Transparent };
        b.MouseEnter += (_, _) => b.Background = new Media.SolidColorBrush(Media.Color.FromArgb(0x12, 0xFF, 0xFF, 0xFF));
        b.MouseLeave += (_, _) => b.Background = Media.Brushes.Transparent;
        b.MouseLeftButtonUp += (_, _) => { HideMenu(); action(); };
        return b;
    }

    public void HideMenu()
    {
        _selfHiding = true;
        try { Hide(); } finally { _selfHiding = false; }
    }

    public void ShowAtCursor()
    {
        bool shown = _widgetShown();
        _toggleText.Text = shown ? "Hide widget" : "Show widget";
        _toggleGlyph.Text = shown ? "" : ""; // Segoe Fluent Icons: Hide, View
        Native.GetCursorPos(out var cur);
        Show();
        UpdateLayout();
        var hwnd = new WindowInteropHelper(this).Handle;
        double s = Native.GetDpiForWindow(hwnd) / 96.0;
        int w = (int)Math.Round(ActualWidth * s), h = (int)Math.Round(ActualHeight * s);
        var wa = Forms.Screen.FromPoint(new System.Drawing.Point(cur.X, cur.Y)).WorkingArea;
        int x = Math.Clamp(cur.X - w / 2, wa.Left + 4, wa.Right - w - 4);
        int y = Math.Clamp(Math.Min(cur.Y, wa.Bottom) - h - 6, wa.Top + 4, wa.Bottom - h - 4);
        Native.SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, Native.SWP_NOSIZE | Native.SWP_NOZORDER);
        Native.SetForegroundWindow(hwnd);
        Activate();
    }
}
