// Helpers for driving the built app from a script: test pictures, the clipboard, the native
// file dialogs (through Win32 window messages) and the page (through WebView2's debugging port,
// bound to 127.0.0.1). Used by native-check.mjs. Windows only.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Test pictures ----------

/** A PNG of the given size: red, with the left half see-through. */
export function png(width, height) {
  const row = 1 + width * 4;
  const raw = Buffer.alloc(row * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * row + 1 + x * 4;
      raw[i] = 220;
      raw[i + 3] = x < width / 2 ? 0 : 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export const pngSize = (buf) => ({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) });

// ---------- PowerShell helpers ----------

export function ps(script) {
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
}

const q = (s) => `'${s.replace(/'/g, "''")}'`;

export const clipboard = {
  image: (path) => ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing; [Windows.Forms.Clipboard]::SetImage([Drawing.Image]::FromFile(${q(path)}))`),
  files: (path) => ps(`Set-Clipboard -Path ${q(path)}`),
  text: (text) => ps(`Set-Clipboard -Value ${q(text)}`),
  formats: () => ps(`Add-Type -AssemblyName System.Windows.Forms; [Windows.Forms.Clipboard]::GetDataObject().GetFormats() -join ','`).split(','),
  pngSize: () => {
    const out = ps(
      `Add-Type -AssemblyName System.Windows.Forms; $s = [Windows.Forms.Clipboard]::GetData('PNG'); $b = New-Object byte[] 26; [void]$s.Read($b, 0, 26); [Convert]::ToBase64String($b)`,
    );
    return pngSize(Buffer.from(out, 'base64'));
  },
};

/** Waits for the app's file dialog, types a path into its file name box and presses its OK button. */
export function fillFileDialog(pid, path) {
  // UI Automation only sees these dialogs as raw windows, so this uses plain Win32 messages.
  return ps(`
Add-Type -TypeDefinition ${q(`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FileDialog {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetDlgItem(IntPtr d, int id);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }
  public static IntPtr Find(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "#32770") { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  // The file name box is a visible edit inside a combo box: id 1001 in Save, inside combo box 1148 in Open.
  // (The address bar's hidden edit is id 41477.)
  public static IntPtr NameBox(IntPtr dlg) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dlg, (h, l) => {
      IntPtr combo = GetParent(h);
      if (Cls(h) == "Edit" && IsWindowVisible(h) && Cls(combo) == "ComboBox" && (GetDlgCtrlID(h) == 1001 || GetDlgCtrlID(combo) == 1148)) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static void Fill(IntPtr dlg, IntPtr box, string path) {
    // Typed in as characters: the Save dialog ignores text set with WM_SETTEXT.
    SendMessage(box, 0x00B1, IntPtr.Zero, (IntPtr)(-1)); // EM_SETSEL, all
    SendMessage(box, 0x0102, (IntPtr)8, IntPtr.Zero); // WM_CHAR backspace
    foreach (char c in path) SendMessage(box, 0x0102, (IntPtr)c, IntPtr.Zero); // WM_CHAR
    System.Threading.Thread.Sleep(200);
    PostMessage(GetDlgItem(dlg, 1), 0x00F5, IntPtr.Zero, IntPtr.Zero); // BM_CLICK on OK
  }
}`)}
$dlg = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(15)
while ($dlg -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  $dlg = [FileDialog]::Find(${pid})
  if ($dlg -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($dlg -eq [IntPtr]::Zero) { throw 'No file dialog appeared' }
$box = [IntPtr]::Zero
$deadline = (Get-Date).AddSeconds(5)
while ($box -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
  $box = [FileDialog]::NameBox($dlg)
  if ($box -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 100 }
}
if ($box -eq [IntPtr]::Zero) { throw 'The file dialog has no file name box' }
[FileDialog]::Fill($dlg, $box, ${q(path)})`);
}

const WM_CLOSE = 0x10;
export function postClose(pid) {
  ps(`
Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
$h = (Get-Process -Id ${pid}).MainWindowHandle
if ($h -eq 0) { throw 'The app has no window' }
[void][N.W]::PostMessage($h, ${WM_CLOSE}, [IntPtr]::Zero, [IntPtr]::Zero)`);
}

/** Like the X on one window `h`, for apps with several. */
export function postCloseWindow(h) {
  ps(`
Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);'
[void][N.W]::PostMessage([IntPtr]${h}, ${WM_CLOSE}, [IntPtr]::Zero, [IntPtr]::Zero)`);
}

// ---------- Screen capture ----------

const SCREEN_CS = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class SketchScreen {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int i);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int l, t, r, b; }
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int n);
  public static void Aware() { SetProcessDpiAwarenessContext((IntPtr)(-4)); }
  static string Cls(IntPtr h) { var s = new StringBuilder(64); GetClassName(h, s, 64); return s.ToString(); }
  static string Title(IntPtr h) { var s = new StringBuilder(256); GetWindowText(h, s, 256); return s.ToString(); }
  /** The capture overlay of a process, or zero. */
  public static long Overlay(uint pid) {
    long found = 0;
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && IsWindowVisible(h) && Cls(h) == "SketchCapture") { found = (long)h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  /** Sketch's own windows, shown or hidden. */
  public static string Windows(uint pid) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && Title(h).EndsWith(" - Sketch")) list.Add((long)h + ":" + (IsWindowVisible(h) ? 1 : 0));
      return true;
    }, IntPtr.Zero);
    return string.Join(",", list);
  }
  public static long Find(string title) {
    long found = 0;
    EnumWindows((h, l) => { if (IsWindowVisible(h) && Title(h) == title) { found = (long)h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  /** The primary screen's size, "w,h". */
  public static string Primary() { return GetSystemMetrics(0) + "," + GetSystemMetrics(1); }
  public static bool Visible(long h) { return IsWindow((IntPtr)h) && IsWindowVisible((IntPtr)h); }
  public static string Bounds(long h) {
    RECT r; DwmGetWindowAttribute((IntPtr)h, 9, out r, 16);
    return r.l + "," + r.t + "," + r.r + "," + r.b;
  }
  public static void Place(long h, int x, int y, int w, int ht, bool top) {
    SetWindowPos((IntPtr)h, (IntPtr)(top ? -1 : -2), x, y, w, ht, 0x0040);
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string cls, string title);
  /** The capture helper's hidden window, found by its title, or zero. */
  public static long Helper(string title) { return (long)FindWindow("SketchCaptureHelper", title); }
  public static uint Pid(long h) { uint p; GetWindowThreadProcessId((IntPtr)h, out p); return p; }
  public static void Send(long h, uint msg) { PostMessage((IntPtr)h, msg, IntPtr.Zero, IntPtr.Zero); }
  /**
   * Posts msg to a window, then times until a Sketch window of pid shows: "posted,ms", where posted is
   * when the message went (Unix ms, to compare with the page's clock) and ms is -1 after 5 s.
   */
  public static string TimeShown(long h, uint msg, uint pid) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    var posted = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
    PostMessage((IntPtr)h, msg, IntPtr.Zero, IntPtr.Zero);
    while (sw.Elapsed.TotalMilliseconds < 5000) {
      if (Windows(pid).Contains(":1")) return posted.ToString("F1", System.Globalization.CultureInfo.InvariantCulture) + "," + sw.Elapsed.TotalMilliseconds.ToString("F1", System.Globalization.CultureInfo.InvariantCulture);
      System.Threading.Thread.Sleep(0);
    }
    return posted + ",-1";
  }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort vk, scan; public uint flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx, dy; public uint data, flags, time; public IntPtr extra; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] inputs, int size);
  /**
   * Presses keys as the keyboard would, through SendInput: a list like "a0d,a0u" of virtual-key codes
   * in hex, each followed by d (down) or u (up). Low-level keyboard hooks see these like real keys.
   */
  public static void Keys(string spec) {
    var list = new List<INPUT>();
    foreach (var k in spec.Split(',')) {
      ushort vk = Convert.ToUInt16(k.Substring(0, k.Length - 1), 16);
      ushort scan = (ushort)(vk == 0xa0 ? 0x2a : vk == 0xa1 ? 0x36 : 0);
      var i = new INPUT { type = 1 };
      i.u.ki = new KEYBDINPUT { vk = vk, scan = scan, flags = k.EndsWith("u") ? 2u : 0u };
      list.Add(i);
    }
    SendInput((uint)list.Count, list.ToArray(), Marshal.SizeOf(typeof(INPUT)));
  }
  [DllImport("user32.dll")] static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public static long Ask(long h, uint msg) { return (long)SendMessage((IntPtr)h, msg, IntPtr.Zero, IntPtr.Zero); }
  /** Posts msg to a window, then the milliseconds until a capture overlay of pid shows (-1 after 5 s). */
  public static long TimeOverlay(long h, uint msg, uint pid) {
    var sw = System.Diagnostics.Stopwatch.StartNew();
    PostMessage((IntPtr)h, msg, IntPtr.Zero, IntPtr.Zero);
    while (sw.ElapsedMilliseconds < 5000) {
      if (Overlay(pid) != 0) return sw.ElapsedMilliseconds;
      System.Threading.Thread.Sleep(1);
    }
    return -1;
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  /** The window in front. */
  public static long Foreground() { return (long)GetForegroundWindow(); }
  /** Minimises a window without activating anything. */
  public static void Minimize(long h) { ShowWindow((IntPtr)h, 7); }
  public static bool Iconic(long h) { return IsIconic((IntPtr)h); }
  /** Sketch's windows with their titles: "handle|title|visible|minimised" joined by semicolons. */
  public static string Titled(uint pid) {
    var list = new List<string>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == pid && Title(h).EndsWith(" - Sketch")) list.Add((long)h + "|" + Title(h) + "|" + (IsWindowVisible(h) ? 1 : 0) + "|" + (IsIconic(h) ? 1 : 0));
      return true;
    }, IntPtr.Zero);
    return string.Join(";", list);
  }
  public static void Maximize(long h) { ShowWindow((IntPtr)h, 3); }
  public static void Restore(long h) { ShowWindow((IntPtr)h, 9); }
  public static bool Zoomed(long h) { return IsZoomed((IntPtr)h); }
  /**
   * Drags over the overlay as Post does, waits for it to close, then presses keys (as Keys) after
   * delay ms: in one call, so the keys come within the second after the capture.
   */
  public static void DragThenKeys(long h, int x1, int y1, int x2, int y2, int delay, string keys) {
    Post(h, 0x200, 0, x1, y1);
    Post(h, 0x201, 1, x1, y1);
    for (int i = 1; i <= 4; i++) Post(h, 0x200, 1, x1 + (x2 - x1) * i / 4, y1 + (y2 - y1) * i / 4);
    Post(h, 0x202, 0, x2, y2);
    var sw = System.Diagnostics.Stopwatch.StartNew();
    while (Visible(h) && sw.ElapsedMilliseconds < 5000) System.Threading.Thread.Sleep(1);
    System.Threading.Thread.Sleep(delay);
    Keys(keys);
  }
  /**
   * As DragThenKeys with a tap of Left Shift, then times until a window of a Sketch running from exe
   * shows: "posted,ms" as TimeShown gives, from the tap.
   */
  public static string DragTapShown(long h, int x1, int y1, int x2, int y2, int delay, string exe) {
    var inv = System.Globalization.CultureInfo.InvariantCulture;
    var sketches = new List<uint>();
    foreach (var p in System.Diagnostics.Process.GetProcessesByName("sketch")) {
      try { if (string.Equals(p.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase)) sketches.Add((uint)p.Id); } catch { }
    }
    DragThenKeys(h, x1, y1, x2, y2, delay, "a0d,a0u");
    var posted = (DateTime.UtcNow - new DateTime(1970, 1, 1)).TotalMilliseconds;
    var sw = System.Diagnostics.Stopwatch.StartNew();
    while (sw.Elapsed.TotalMilliseconds < 5000) {
      // The hidden Sketch started during the drag, so the list is read again until one shows.
      if (sw.ElapsedMilliseconds % 50 == 0) {
        foreach (var p in System.Diagnostics.Process.GetProcessesByName("sketch")) {
          try { if (!sketches.Contains((uint)p.Id) && string.Equals(p.MainModule.FileName, exe, StringComparison.OrdinalIgnoreCase)) sketches.Add((uint)p.Id); } catch { }
        }
      }
      foreach (var pid in sketches) if (Windows(pid).Contains(":1")) return posted.ToString("F1", inv) + "," + sw.Elapsed.TotalMilliseconds.ToString("F1", inv);
      System.Threading.Thread.Sleep(0);
    }
    return posted.ToString("F1", inv) + ",-1";
  }
  /** Posts a mouse or key message to the overlay; x and y are screen positions. */
  public static void Post(long h, uint msg, long wparam, int x, int y) {
    int cx = x - GetSystemMetrics(76), cy = y - GetSystemMetrics(77);
    PostMessage((IntPtr)h, msg, (IntPtr)wparam, (IntPtr)((cy << 16) | (cx & 0xffff)));
  }
}`;

let screenDll = null;

/**
 * Win32 helpers for the capture checks, compiled once into the work folder. Each call is one
 * PowerShell run; `script` is PowerShell that can use [SketchScreen].
 */
export function screen(work, script) {
  if (!screenDll) {
    screenDll = join(work, 'sketch-screen.dll');
    ps(`Add-Type -TypeDefinition ${q(SCREEN_CS)} -OutputAssembly ${q(screenDll)}`);
  }
  return ps(`Add-Type -Path ${q(screenDll)}; [SketchScreen]::Aware(); ${script}`);
}

// SET_MODE is the overlay's own message for picking a mode (`WM_SET_MODE` in capture.rs).
const WM = { MOUSEMOVE: 0x200, LBUTTONDOWN: 0x201, LBUTTONUP: 0x202, KEYDOWN: 0x100, SET_MODE: 0x8001 };

/** Drives the capture overlay with posted messages, so the real mouse and keyboard are never used. */
export const overlay = {
  /** Waits for a process's overlay to show and returns its window. */
  async find(work, pid, ms = 10000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const h = Number(screen(work, `[SketchScreen]::Overlay(${pid})`));
      if (h) return h;
      await sleep(100);
    }
    throw new Error('The capture overlay did not appear');
  },
  async gone(work, h, ms = 5000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (screen(work, `[SketchScreen]::Visible(${h})`) === 'False') return;
      await sleep(100);
    }
    throw new Error('The capture overlay is still showing');
  },
  drag: (work, h, x1, y1, x2, y2) =>
    screen(
      work,
      [
        `[SketchScreen]::Post(${h}, ${WM.MOUSEMOVE}, 0, ${x1}, ${y1})`,
        `[SketchScreen]::Post(${h}, ${WM.LBUTTONDOWN}, 1, ${x1}, ${y1})`,
        ...[1, 2, 3, 4].map((i) => `[SketchScreen]::Post(${h}, ${WM.MOUSEMOVE}, 1, ${Math.round(x1 + ((x2 - x1) * i) / 4)}, ${Math.round(y1 + ((y2 - y1) * i) / 4)})`),
        `[SketchScreen]::Post(${h}, ${WM.LBUTTONUP}, 0, ${x2}, ${y2})`,
      ].join('; '),
    ),
  click: (work, h, x, y) => overlay.drag(work, h, x, y, x, y),
  /** Drags as `drag` does, waits for the overlay to close, then presses `keys` (as the `keys` export takes them) after `delay` ms, all in one call. */
  dragThenKeys: (work, h, x1, y1, x2, y2, delay, keys) => screen(work, `[SketchScreen]::DragThenKeys(${h}, ${x1}, ${y1}, ${x2}, ${y2}, ${delay}, '${keys}')`),
  /** Drags, taps Left Shift `delay` ms after the overlay closes, and gives the ms from the tap until a window of a Sketch running from `exe` shows (-1 after 5 s). */
  dragTapShown(work, h, x1, y1, x2, y2, delay, exe) {
    const [posted, ms] = screen(work, `[SketchScreen]::DragTapShown(${h}, ${x1}, ${y1}, ${x2}, ${y2}, ${delay}, '${exe.replace(/'/g, "''")}')`).split(',').map(Number);
    return { posted, ms };
  },
  /** Picks a mode as the toolbar does: 0 area (the default), 1 window, 2 full screen. */
  mode: (work, h, mode) => screen(work, `[SketchScreen]::Post(${h}, ${WM.SET_MODE}, ${mode}, 0, 0)`),
  /** Moves the pointer there, then presses a key (by virtual-key code). */
  key: (work, h, vk, x, y) => screen(work, `[SketchScreen]::Post(${h}, ${WM.MOUSEMOVE}, 0, ${x}, ${y}); [SketchScreen]::Post(${h}, ${WM.KEYDOWN}, ${vk}, 0, 0)`),
};

/** The capture helper's window title for a data folder: `tag` in helper.rs (FNV-1a of the lower-case path). */
export function helperTag(dir) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(dir.toLowerCase(), 'utf8')) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return `sketch-capture-${h.toString(16).padStart(16, '0')}`;
}

// The helper's test messages (test hooks only): WM_TEST_KEYS acts as if the keys were pressed,
// WM_TEST_CLICK as if its newest notification was clicked, WM_TEST_DISMISS as if it was dismissed,
// and WM_TEST_WATCHING answers how many Left Shift hooks (F16) it has installed.
const HELPER_WM = { KEYS: 0x8003, CLICK: 0x8004, DISMISS: 0x8005, WATCHING: 0x8006 };

/** Drives the capture helper (sketch-capture.exe) of a data folder through its hidden window. */
export const helper = {
  find: (work, dir) => Number(screen(work, `[SketchScreen]::Helper('${helperTag(dir)}')`)),
  /** Waits for the helper to be running (or, with `running` false, gone) and returns its window. */
  async wait(work, dir, running = true, ms = 6000) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const h = helper.find(work, dir);
      if (Boolean(h) === running) return h;
      await sleep(150);
    }
    throw new Error(running ? "The capture helper isn't running" : 'The capture helper is still running');
  },
  pid: (work, h) => Number(screen(work, `[SketchScreen]::Pid(${h})`)),
  keys: (work, h) => screen(work, `[SketchScreen]::Send(${h}, ${HELPER_WM.KEYS})`),
  click: (work, h) => screen(work, `[SketchScreen]::Send(${h}, ${HELPER_WM.CLICK})`),
  dismiss: (work, h) => screen(work, `[SketchScreen]::Send(${h}, ${HELPER_WM.DISMISS})`),
  watching: (work, h) => Number(screen(work, `[SketchScreen]::Ask(${h}, ${HELPER_WM.WATCHING})`)),
  /** Clicks the newest notification (as a message) and times until a window of Sketch process `pid` shows: `{ posted, ms }`. */
  timeShown(work, h, pid) {
    const [posted, ms] = screen(work, `[SketchScreen]::TimeShown(${h}, ${HELPER_WM.CLICK}, ${pid})`).split(',').map(Number);
    return { posted, ms };
  },
  /** Presses the keys (as a message) and times how long until the overlay of process `pid` shows. */
  timeOverlay: (work, h, pid) => Number(screen(work, `[SketchScreen]::TimeOverlay(${h}, ${HELPER_WM.KEYS}, ${pid})`)),
};

/**
 * Keys pressed as the keyboard would (SendInput), which go to whatever window is in front: virtual-key
 * codes in hex with d or u, like "a0d,a0u" for a tap of Left Shift. Use keys that type nothing.
 */
export const keys = (work, spec) => screen(work, `[SketchScreen]::Keys('${spec}')`);
/** How many of a Sketch process's capture notifications (group `capture-<pid>`) are in the notification centre. */
export function notesInCentre(pid) {
  return Number(
    ps(`[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
([Windows.UI.Notifications.ToastNotificationManager]::History.GetHistory('app.sketch.desktop') | Where-Object { $_.Group -eq 'capture-${pid}' } | Measure-Object).Count`),
  );
}

/** A plain magenta window with no border, from a PowerShell process of its own, to capture. Kill it when done. */
export async function captureTarget(work, x, y, w, h) {
  const title = 'Sketch capture target';
  screen(work, '$null'); // Makes sure the helper DLL exists before the form's PowerShell loads it.
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-Command',
      `Add-Type -Path ${q(join(work, 'sketch-screen.dll'))}; [SketchScreen]::Aware(); Add-Type -AssemblyName System.Windows.Forms,System.Drawing;
$f = New-Object Windows.Forms.Form; $f.FormBorderStyle = 'None'; $f.BackColor = [Drawing.Color]::FromArgb(255, 0, 255);
$f.StartPosition = 'Manual'; $f.Bounds = New-Object Drawing.Rectangle(${x}, ${y}, ${w}, ${h}); $f.TopMost = $true; $f.ShowInTaskbar = $false; $f.Text = '${title}';
[Windows.Forms.Application]::Run($f)`,
    ],
    { stdio: 'ignore', windowsHide: false },
  );
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    const hwnd = Number(screen(work, `[SketchScreen]::Find('${title}')`));
    if (hwnd) return { child, hwnd };
    await sleep(150);
  }
  child.kill();
  throw new Error("The capture target window didn't appear");
}

/** Holds a global hotkey from a PowerShell process of its own until killed, as another app would. */
export async function holdHotkey(mods, vk) {
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Add-Type -Name H -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr h, int id, uint m, uint vk);'
if ([N.H]::RegisterHotKey([IntPtr]::Zero, 1, ${mods}, ${vk})) { 'held' } else { 'taken' }
Start-Sleep -Seconds 120`,
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const answer = await new Promise((r) => child.stdout.once('data', (d) => r(String(d).trim())));
  if (answer !== 'held') {
    child.kill();
    throw new Error(`Couldn't hold the hotkey for the check (${answer})`);
  }
  return child;
}

// ---------- Driving the page ----------

let launches = 0;

/**
 * Starts the app with its debugging port open and returns helpers for driving its page.
 * `profile` names a WebView2 data folder to reuse, so settings saved in one launch can be read in the next.
 * The app's data folder (autosaves, updates) is `work/data` unless `extraEnv` sets SKETCH_DATA_DIR, so a
 * check never touches the user's own and never reaches a Sketch the user has open.
 */
export async function launch(exe, work, args = [], profile = null, extraEnv = {}) {
  const port = 9300 + Math.floor(Math.random() * 600);
  launches++;
  // Windows' mouse speed is one setting for the whole PC, so the app changes a stand-in file instead.
  const mouseSpeed = join(work, 'mouse-speed.txt');
  if (!existsSync(mouseSpeed)) writeFileSync(mouseSpeed, '10');
  const child = spawn(exe, args, {
    stdio: 'ignore',
    cwd: work, // File dialogs start here, so a missed path never saves into the project.
    env: {
      ...process.env,
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
      // A separate profile, so the check never touches the user's own app data.
      WEBVIEW2_USER_DATA_FOLDER: join(work, profile ? `webview-${profile}` : `webview-${launches}`),
      SKETCH_DATA_DIR: join(work, 'data'),
      SKETCH_TEST_HOOKS: '1',
      SKETCH_TEST_MOUSE_SPEED: mouseSpeed,
      ...extraEnv,
    },
  });
  child.exited = new Promise((r) => child.on('exit', r));
  return connect(port, child);
}

/**
 * Connects to a Sketch that something else started (the capture helper, clicking a notification)
 * with the debugging port and WebView2 folder it inherited from an earlier `launch`. `pid` is its
 * process, for quitting it.
 */
export async function attach(port, pid) {
  const gone = () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  };
  const exited = (async () => {
    while (!gone()) await sleep(150);
  })();
  return connect(port, { pid, exited, kill: () => !gone() && process.kill(pid) });
}

async function connect(port, child) {
  let wsUrl = null;
  const deadline = Date.now() + 20000;
  while (!wsUrl && Date.now() < deadline) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      wsUrl = pages.find((p) => p.type === 'page')?.webSocketDebuggerUrl ?? null;
    } catch {}
    if (!wsUrl) await sleep(150);
  }
  if (!wsUrl) throw new Error("Couldn't reach the app's debugging port");

  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let nextId = 1;
  const waiting = new Map();
  // Console output and uncaught errors from the page, for explaining failures.
  const logs = [];
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.method === 'Runtime.consoleAPICalled') {
      logs.push(`console.${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      logs.push(`uncaught: ${d.exception?.description ?? (d.exception?.value !== undefined ? `${d.text} ${JSON.stringify(d.exception.value)}` : d.text)}`);
    }
    if (msg.id && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((r, j) => {
      const id = nextId++;
      waiting.set(id, (msg) => (msg.error ? j(new Error(`${method}: ${msg.error.message}`)) : r(msg.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text);
    return res.result.value;
  };

  const KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Escape: { code: 'Escape', keyCode: 27 },
    ',': { code: 'Comma', keyCode: 188 },
    F10: { code: 'F10', keyCode: 121 },
    F4: { code: 'F4', keyCode: 115 },
    Tab: { code: 'Tab', keyCode: 9 },
  };
  /** Presses a key. `mods`: 1 is Alt, 2 is Ctrl, 8 is Shift. */
  const press = async (key, mods = 0, commands) => {
    const info = KEYS[key] ?? { code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) };
    const base = { key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: mods };
    await send('Input.dispatchKeyEvent', { type: info.text && !mods ? 'keyDown' : 'rawKeyDown', ...base, text: mods ? undefined : info.text, commands });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const drag = async (x1, y1, x2, y2) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x1, y: y1, button: 'left', buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 8; i++) {
      await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x1 + ((x2 - x1) * i) / 8, y: y1 + ((y2 - y1) * i) / 8, button: 'left', buttons: 1 });
    }
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x2, y: y2, button: 'left', buttons: 0, clickCount: 1 });
  };

  const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent ?? null`);
  const state = () =>
    evaluate(`({
      title: document.title,
      size: document.querySelector('.st-size')?.textContent,
      floating: document.querySelector('.st-selection')?.textContent,
      tool: document.querySelector('.tool-name')?.textContent,
      toast: document.querySelector('.toast')?.textContent ?? null,
      dialog: document.querySelector('.dialog h2')?.textContent ?? null,
      tabs: window.sketch?.tabs.list.length ?? null,
    })`);

  const waitFor = async (what, check, ms = 8000) => {
    const end = Date.now() + ms;
    let last;
    while (Date.now() < end) {
      last = await state();
      if (check(last)) return last;
      await sleep(100);
    }
    throw new Error(`Timed out waiting for ${what}. Last state: ${JSON.stringify(last)}`);
  };

  const clickButton = (label) =>
    evaluate(`(() => {
      const b = [...document.querySelectorAll('.dialog button')].find((b) => b.textContent === ${JSON.stringify(label)});
      if (!b) throw new Error(${JSON.stringify(`No ${label} button`)});
      b.click();
    })()`);

  await send('Runtime.enable');
  await waitFor('the first picture', (s) => /px$/.test(s.size ?? ''));
  // The page exposes its state for checks once it has asked whether test hooks are on, which can come after the first picture.
  for (let end = Date.now() + 5000; Date.now() < end && !(await evaluate('!!window.sketch')); ) await sleep(50);
  const dpr = await evaluate('window.devicePixelRatio');
  const canvasBox = await evaluate(`(() => { const r = document.querySelector('canvas.view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

    /** Waits up to `ms` for the app to exit; kills it if it doesn't. Resolves true if it exited by itself. */
  const quit = async (ms = 0) => {
    const exited = await Promise.race([child.exited.then(() => true), sleep(ms).then(() => false)]);
    ws.close();
    if (!exited) {
      child.kill();
      await child.exited;
    }
    return exited;
  };

  /** Titles of the app's open windows, from the debugging port. */
  const windowTitles = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((p) => p.type === 'page').map((p) => p.title);

  return { child, pid: child.pid, port, windowTitles, logs, send, evaluate, press, drag, text, state, waitFor, clickButton, dpr, canvasBox, quit };
}
