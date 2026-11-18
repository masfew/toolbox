using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Media;

namespace Vitals;

internal static class Theme
{
    public static readonly SolidColorBrush Text = Brush(0xFF, 0xF4, 0xF4, 0xF5);
    public static readonly SolidColorBrush Dim = Brush(0xA3, 0xFF, 0xFF, 0xFF);
    public static readonly SolidColorBrush Faint = Brush(0x66, 0xFF, 0xFF, 0xFF);
    public static readonly SolidColorBrush Line = Brush(0x17, 0xFF, 0xFF, 0xFF);
    public static readonly SolidColorBrush Track = Brush(0x17, 0xFF, 0xFF, 0xFF);
    public static readonly SolidColorBrush RowBack = Brush(0x0A, 0xFF, 0xFF, 0xFF);

    public static readonly Color CpuColor = Color.FromRgb(0x4C, 0xC2, 0xFF);
    public static readonly Color GpuColor = Color.FromRgb(0x7F, 0xDC, 0x6F);
    public static readonly Color RamColor = Color.FromRgb(0xC4, 0x9B, 0xFF);
    public static readonly Color VramColor = Color.FromRgb(0xFF, 0xB4, 0x54);

    public static readonly SolidColorBrush Warm = Brush(0xFF, 0xFF, 0xB4, 0x54);
    public static readonly SolidColorBrush Hot = Brush(0xFF, 0xFF, 0x6B, 0x6B);

    public static readonly FontFamily TextFont = new("Segoe UI Variable Text, Segoe UI");
    public static readonly FontFamily DisplayFont = new("Segoe UI Variable Display, Segoe UI");
    public static readonly FontFamily IconFont = new("Segoe Fluent Icons, Segoe MDL2 Assets");

    private static readonly Dictionary<Color, SolidColorBrush> Cache = new();

    public static SolidColorBrush Solid(Color c)
    {
        if (!Cache.TryGetValue(c, out var b)) { b = new SolidColorBrush(c); b.Freeze(); Cache[c] = b; }
        return b;
    }

    public static SolidColorBrush WithAlpha(Color c, byte alpha) => Solid(Color.FromArgb(alpha, c.R, c.G, c.B));

    public static SolidColorBrush Card(double opacity) => Solid(Color.FromArgb((byte)Math.Round(Math.Clamp(opacity, 0, 1) * 255), 0x1E, 0x1E, 0x21));

    private static SolidColorBrush Brush(byte a, byte r, byte g, byte b)
    {
        var br = new SolidColorBrush(Color.FromArgb(a, r, g, b));
        br.Freeze();
        return br;
    }
}

/// <summary>A progress ring: a faint full circle with a coloured arc from the top, clockwise.</summary>
public sealed class Ring : FrameworkElement
{
    private double _value;
    private Brush _brush = Brushes.White;
    private double _thickness = 4;

    public double Value { get => _value; set { var v = Math.Clamp(value, 0, 1); if (Math.Abs(v - _value) > 0.0005) { _value = v; InvalidateVisual(); } } }
    public Brush Brush { get => _brush; set { _brush = value; InvalidateVisual(); } }
    public double Thickness { get => _thickness; set { _thickness = value; InvalidateVisual(); } }

    protected override void OnRender(DrawingContext dc)
    {
        double size = Math.Min(ActualWidth, ActualHeight);
        if (size <= 0) return;
        double r = (size - _thickness) / 2;
        var c = new Point(ActualWidth / 2, ActualHeight / 2);
        var track = new Pen(Theme.Track, _thickness);
        dc.DrawEllipse(null, track, c, r, r);

        double v = Math.Max(0.006, _value);
        var pen = new Pen(_brush, _thickness) { StartLineCap = PenLineCap.Round, EndLineCap = PenLineCap.Round };
        if (v >= 0.999) { dc.DrawEllipse(null, pen, c, r, r); return; }
        double a = v * 2 * Math.PI;
        var start = new Point(c.X, c.Y - r);
        var end = new Point(c.X + r * Math.Sin(a), c.Y - r * Math.Cos(a));
        var g = new StreamGeometry();
        using (var ctx = g.Open())
        {
            ctx.BeginFigure(start, false, false);
            ctx.ArcTo(end, new Size(r, r), 0, v > 0.5, SweepDirection.Clockwise, true, false);
        }
        g.Freeze();
        dc.DrawGeometry(null, pen, g);
    }
}

/// <summary>A small line graph of the last readings, newest on the right, with a faint fill underneath.</summary>
public sealed class Sparkline : FrameworkElement
{
    private double[] _values = Array.Empty<double>();
    private double _max = 100;
    private int _capacity = 60;
    private Color _color = Colors.White;

    public void Set(double[] values, double max, int capacity)
    {
        _values = values;
        _max = max <= 0 ? 1 : max;
        _capacity = Math.Max(2, capacity);
        InvalidateVisual();
    }

    public Color Color { get => _color; set { _color = value; InvalidateVisual(); } }

    protected override void OnRender(DrawingContext dc)
    {
        double w = ActualWidth, h = ActualHeight;
        if (w <= 0 || h <= 0 || _values.Length < 2) return;
        const double pad = 1.5;
        double dx = w / (_capacity - 1);
        double x0 = w - (_values.Length - 1) * dx;
        var pts = new Point[_values.Length];
        for (int i = 0; i < _values.Length; i++)
            pts[i] = new Point(x0 + i * dx, h - pad - Math.Clamp(_values[i] / _max, 0, 1) * (h - pad * 2));

        var line = new StreamGeometry();
        using (var ctx = line.Open())
        {
            ctx.BeginFigure(pts[0], false, false);
            ctx.PolyLineTo(pts[1..], true, true);
        }
        line.Freeze();

        var area = new StreamGeometry();
        using (var ctx = area.Open())
        {
            ctx.BeginFigure(new Point(pts[0].X, h), true, true);
            ctx.LineTo(pts[0], false, false);
            ctx.PolyLineTo(pts[1..], false, false);
            ctx.LineTo(new Point(pts[^1].X, h), false, false);
        }
        area.Freeze();

        dc.DrawGeometry(Theme.WithAlpha(_color, 0x26), null, area);
        dc.DrawGeometry(null, new Pen(Theme.Solid(_color), 1.5) { LineJoin = PenLineJoin.Round }, line);
    }
}
