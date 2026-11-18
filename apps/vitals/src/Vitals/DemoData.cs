using System;
using System.Collections.Generic;

namespace Vitals;

/// <summary>
/// Made-up readings for <c>--render &lt;folder&gt; --demo</c>, so pictures of the widget (such as the README's) show
/// nothing from the PC they're made on: no real app names, sizes or temperatures. The same every time.
/// </summary>
internal static class DemoData
{
    /// <summary>A minute of readings, oldest first, ending on <see cref="Last"/>.</summary>
    public static IEnumerable<Snapshot> Minute(int count)
    {
        for (int i = 0; i < count; i++)
        {
            double cpu = 22 + 9 * Math.Sin(i * 0.31) + 5 * Math.Sin(i * 0.87 + 1);
            double gpu = 38 + 12 * Math.Sin(i * 0.19 + 2) + 4 * Math.Sin(i * 0.73);
            double ram = 11.4 + 0.4 * Math.Sin(i * 0.07);
            double vram = 6.8 + 0.3 * Math.Sin(i * 0.09 + 1);
            yield return i == count - 1 ? Last : new Snapshot(cpu, 50 + cpu / 10, gpu, 55 + gpu / 12, ram, 32, vram, 16);
        }
    }

    public static readonly Snapshot Last = new(24, 52, 41, 58, 11.8, 32, 7.1, 16);

    public static readonly AppUsage Apps = new(
        Cpu: new[] { new AppRow("browser.exe", 9.4), new AppRow("game.exe", 6.1), new AppRow("editor.exe", 2.3) },
        Gpu: new[] { new AppRow("game.exe", 36), new AppRow("browser.exe", 4.2), new AppRow("video.exe", 1.8) },
        Ram: new[] { new AppRow("browser.exe", 3.1), new AppRow("game.exe", 2.4), new AppRow("editor.exe", 0.9) },
        Vram: new[] { new AppRow("game.exe", 5.2), new AppRow("browser.exe", 0.8), new AppRow("video.exe", 0.4) });
}
