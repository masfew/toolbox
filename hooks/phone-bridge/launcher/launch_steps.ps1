# The phone launcher's steps inside the Claude desktop app (Windows UI Automation).
# launch.py runs this hidden and talks to it over stdin and stdout, one JSON
# object per line:
#   in:  {"prompt": "...", "mode": "Auto", "timeout": 20, "environment": null or "Work"}
#   out: {"event": "step", ...}   progress, for launch.py's log
#        {"event": "ready"}       focus and prompt checked; waits for "go" or "stop"
#        {"event": "done", ...}   the new session started
#        {"event": "retry", "why": "..."}  nothing was sent; launch.py may try again
#        {"event": "fail", "step": "...", "message": "..."}  nothing was sent
# Controls are found by their accessible names, never by screen position. Nothing
# here types or clicks except the one Enter, which goes only to Claude's message
# box when it holds exactly the prompt and launch.py has seen no input since the
# launch began, and, for a saved environment under the picker's "More" submenu,
# one Right arrow while that submenu's item has the focus.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Windows.Forms
# The window helpers are C#, compiled once into a DLL kept in
# ~/.claude/phone-bridge/launcher-cache (named by a hash of the source, so a change
# recompiles). Compiling on every launch failed now and then with "Cannot execute
# a program" from csc.exe (1 run in 13 on 21 Oct 2026). The hash ignores line
# endings: with core.autocrlf a git checkout rewrites this file with CRLF, and on
# 21 Oct 2026 that forced a recompile that failed on every launch from the listener.
$winSource = @'
using System; using System.Runtime.InteropServices;
public static class PhoneLauncherWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
  // The app's main window (top-level, no owner, titled "Claude"), shown or
  // hidden. Process.MainWindowHandle names only one window per process, the
  // topmost visible one: when another window of the app was shown above the
  // main one, or the main one was hidden in the tray, the launcher thought
  // Claude wasn't running (21 Oct 2026, with the app open in front).
  public static IntPtr AppWindow(uint[] pids) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0 || GetWindow(h, 4) != IntPtr.Zero) return true;
      var title = new System.Text.StringBuilder(64); GetWindowText(h, title, 64);
      if (title.ToString() != "Claude") return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  // "class 'title'" of each visible top-level window of these processes, for the
  // log when the main window can't be found.
  public static string Describe(uint[] pids) {
    var list = new System.Collections.Generic.List<string>();
    EnumWindows((h, l) => {
      uint pid; GetWindowThreadProcessId(h, out pid);
      if (Array.IndexOf(pids, pid) < 0 || !IsWindowVisible(h)) return true;
      var title = new System.Text.StringBuilder(64); GetWindowText(h, title, 64);
      var cls = new System.Text.StringBuilder(64); GetClassName(h, cls, 64);
      list.Add(cls + " '" + title + "'" + (GetWindow(h, 4) != IntPtr.Zero ? " (owned)" : ""));
      return true;
    }, IntPtr.Zero);
    return list.Count == 0 ? "none" : string.Join("; ", list);
  }
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct InputUnion { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public InputUnion u; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  // An extended key (such as the arrows), pressed and released, marked as the
  // launcher's own input (launch.py's OWN_INPUT) so its input watch ignores it.
  public static uint OwnExtendedKey(ushort vk) {
    var keys = new INPUT[2];
    keys[0].type = 1; keys[0].u.ki.wVk = vk; keys[0].u.ki.dwFlags = 1; keys[0].u.ki.dwExtraInfo = (IntPtr)0x50484C4E;
    keys[1] = keys[0]; keys[1].u.ki.dwFlags = 3;
    return SendInput(2, keys, Marshal.SizeOf(typeof(INPUT)));
  }
}
'@
$hash = -join ([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes(($winSource -replace "`r`n", "`n")))[0..5] |
  ForEach-Object { $_.ToString('x2') })
$cacheDir = Join-Path $env:USERPROFILE '.claude\phone-bridge\launcher-cache'
$dll = Join-Path $cacheDir "PhoneLauncherWin-$hash.dll"
if (-not (Test-Path $dll)) {
  [void](New-Item -ItemType Directory -Force $cacheDir)
  $build = Join-Path $cacheDir "build-$PID.dll"
  for ($i = 1; -not (Test-Path $dll); $i++) {
    try { Add-Type -TypeDefinition $winSource -OutputAssembly $build -OutputType Library; Move-Item -Force $build $dll }
    catch { if ($i -ge 3) { throw }; Start-Sleep -Seconds 1 }
  }
}
Add-Type -Path $dll

$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]
$True_ = [System.Windows.Automation.Condition]::TrueCondition

function Say($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Step($name, $extra) { $o = @{ event = 'step'; name = $name }; if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }; Say $o }
function Fail($step, $message) { Say @{ event = 'fail'; step = $step; message = $message }; exit 0 }
function Retry($why) { Say @{ event = 'retry'; why = $why }; exit 0 }

# Line endings and trailing spaces differ between Telegram and the message box.
function Norm($s) { if ($null -eq $s) { return $null }; (($s -replace "`r`n", "`n") -replace "`r", "`n").Trim() }

function AppPids {
  [uint32[]]@(Get-Process claude -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -match '\\WindowsApps\\|\\AnthropicClaude\\' } | ForEach-Object Id)
}
function ClaudeWindow {
  $pids = AppPids
  if ($pids.Count -eq 0) { return [IntPtr]::Zero }
  [PhoneLauncherWin]::AppWindow($pids)
}
function Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function FindPrompt($root) {
  $root.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.AndCondition((Cond $A::NameProperty 'Prompt'), (Cond $A::ControlTypeProperty $CT::Edit))))
}
function Value($el) { try { $el.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { $null } }
function FindButton($root, $prefix) {
  $buttons = $root.FindAll($TS::Descendants, (Cond $A::ControlTypeProperty $CT::Button))
  foreach ($b in $buttons) { try { if ($b.Current.Name.StartsWith($prefix)) { return $b } } catch {} }
  $null
}
# Picker options can open in the main window or in a popup window of the app.
function SearchRoots($root) {
  $roots = @($root)
  $pids = @(Get-Process claude -ErrorAction SilentlyContinue | ForEach-Object Id)
  foreach ($w in $A::RootElement.FindAll($TS::Children, $True_)) {
    try { if ($pids -contains $w.Current.ProcessId -and -not [System.Windows.Automation.Automation]::Compare($w, $root)) { $roots += $w } } catch {}
  }
  $roots
}
function FindOption($root, $match) {
  foreach ($r in (SearchRoots $root)) {
    foreach ($e in $r.FindAll($TS::Descendants, $True_)) {
      try {
        $t = $e.Current.ControlType
        if (($t -eq $CT::RadioButton -or $t -eq $CT::MenuItem) -and $e.Current.Name -match $match) { return $e }
      } catch {}
    }
  }
  $null
}
function Pick($el) {
  $pattern = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return $true }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); return $true }
  $false
}
# A submenu item such as "More 11" ignores Expand; it opens with the Right arrow
# while it has the focus. The key goes only when the system-wide focus is on that
# item, and carries the launcher's own marker, so launch.py doesn't count it as
# someone using the PC.
function OpenSubmenu($el) {
  try { $el.SetFocus() } catch { return $false }
  Start-Sleep -Milliseconds 200
  try { if (-not [System.Windows.Automation.Automation]::Compare($A::FocusedElement, $el)) { return $false } } catch { return $false }
  [void][PhoneLauncherWin]::OwnExtendedKey(0x27)  # VK_RIGHT
  $true
}

# Opens a picker button ("Environment: ...") and chooses the option whose name
# matches, then checks the button's new name. The options aren't in the tree
# until the menu opens, so they're looked up by name after expanding. With
# $moreMatch, an option that isn't in the menu is looked for in the submenu
# that matches it (the Environment picker shows its latest saved environment
# and puts the rest under "More <count>").
function Choose($root, $prefix, $optionMatch, $expected, $what, $moreMatch) {
  $button = FindButton $root $prefix
  if (-not $button) { Fail $what "couldn't find the $($prefix.TrimEnd(':', ' ')) button" }
  $before = $button.Current.Name
  if ($before -match $expected) { Step $what @{ already = $before }; return }
  $ec = $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern)  # it has no Invoke pattern
  $ec.Expand()
  $option = $null; $opened = $false; $t = Get-Date
  while (-not $option -and ((Get-Date) - $t).TotalSeconds -lt 5) {
    Start-Sleep -Milliseconds 250
    $option = FindOption $root $optionMatch
    if (-not $option -and $moreMatch -and -not $opened -and ((Get-Date) - $t).TotalSeconds -ge 1) {
      $more = FindOption $root $moreMatch
      if ($more) { $opened = OpenSubmenu $more; Step $what @{ submenu = $(if ($opened) { 'opened' } else { 'not focused' }) } }
    }
  }
  if (-not $option -or -not (Pick $option)) {
    try { $ec.Collapse() } catch {}
    Fail $what "couldn't choose $what"
  }
  $after = $null; $t = Get-Date
  while (((Get-Date) - $t).TotalSeconds -lt 4) {
    Start-Sleep -Milliseconds 250
    $button = FindButton $root $prefix
    if ($button) { $after = $button.Current.Name; if ($after -match $expected) { break } }
  }
  if ($after -notmatch $expected) {
    try { if ($button) { $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } } catch {}
    Fail $what "$what didn't stick (the button reads `"$after`")"
  }
  Step $what @{ before = $before; after = $after }
}

function FocusOk($promptEl, $prompt) {
  try {
    $focused = $A::FocusedElement
    return ([System.Windows.Automation.Automation]::Compare($focused, $promptEl) -and (Norm (Value $promptEl)) -ceq $prompt)
  } catch { return $false }
}

function Restore($previous, $claude) {
  if ($previous -eq [IntPtr]::Zero -or $previous -eq $claude -or -not [PhoneLauncherWin]::IsWindow($previous)) { return 'not needed' }
  if ([PhoneLauncherWin]::SetForegroundWindow($previous)) { return 'restored' }
  # Windows refuses a background program the foreground unless it shares input with the window in front.
  $p = 0
  $front = [PhoneLauncherWin]::GetWindowThreadProcessId([PhoneLauncherWin]::GetForegroundWindow(), [ref]$p)
  $mine = [PhoneLauncherWin]::GetCurrentThreadId()
  $attached = [PhoneLauncherWin]::AttachThreadInput($mine, $front, $true)
  $ok = [PhoneLauncherWin]::SetForegroundWindow($previous)
  if ($attached) { [void][PhoneLauncherWin]::AttachThreadInput($mine, $front, $false) }
  if ($ok) { 'restored (shared input)' } else { 'refused' }
}

try {
  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  $prompt = Norm $request.prompt
  $mode = $request.mode
  $timeout = [int]$request.timeout
  $previous = [PhoneLauncherWin]::GetForegroundWindow()

  $claude = ClaudeWindow
  # The window can be missing for a moment (the app starting up or reloading).
  for ($i = 0; $claude -eq [IntPtr]::Zero -and $i -lt 10; $i++) { Start-Sleep -Milliseconds 300; $claude = ClaudeWindow }
  if ($claude -eq [IntPtr]::Zero) {
    $pids = AppPids
    if ($pids.Count -gt 0) { Step 'app' @{ app_processes = $pids.Count; windows = [PhoneLauncherWin]::Describe($pids) } }
    Fail 'app' "Claude isn't running on the PC"
  }
  # A window closed to the tray is hidden and its controls can't be found. 5 = SW_SHOW.
  $hidden = -not [PhoneLauncherWin]::IsWindowVisible($claude)
  if ($hidden) { [void][PhoneLauncherWin]::ShowWindow($claude, 5) }
  Step 'app' @{ hidden = $hidden; minimized = [PhoneLauncherWin]::IsIconic($claude); claude_in_front = ($previous -eq $claude) }

  # The app's own link opens the new-session screen with the prompt filled in.
  # A folder= parameter would show "Trust this workspace" every time, so the
  # folder is chosen in the picker instead.
  $t0 = Get-Date
  Start-Process ("claude://code/new?q=" + [uri]::EscapeDataString($request.prompt))
  $root = $null; $promptEl = $null
  while (((Get-Date) - $t0).TotalSeconds -lt $timeout) {
    $claude = ClaudeWindow
    if ($claude -ne [IntPtr]::Zero) {
      $root = $A::FromHandle($claude)
      $promptEl = FindPrompt $root
      if ($promptEl -and (Norm (Value $promptEl)) -ceq $prompt) { break }
    }
    $promptEl = $null
    Start-Sleep -Milliseconds 300
  }
  if (-not $promptEl) { Fail 'link' "the message box never got the prompt" }
  Step 'link' @{ seconds = [Math]::Round(((Get-Date) - $t0).TotalSeconds, 1) }

  if ($request.environment) {
    # A saved environment brings its own folder, so the Folder picker is left as it sets it.
    # The latest one's option reads "Work , edit environment, right arrow".
    $name = [regex]::Escape($request.environment)
    Choose $root 'Environment: ' ("^" + $name + "(\s*,.*)?$") ("^Environment: " + $name + "$") "environment $($request.environment)" '^More\b'
    $folder = FindButton $root 'Folder: '
    Step 'folder' @{ reads = $(if ($folder) { $folder.Current.Name } else { 'no Folder button' }) }
  } else {
    Choose $root 'Environment: ' '^This computer$' '^Environment: This computer$' 'This computer'
    # With No folder chosen the button reads "Folder: Choose folder" plus an ellipsis.
    # (This file stays ASCII: Windows PowerShell 5.1 reads it in the ANSI code page.)
    Choose $root 'Folder: ' '^No folder$' '^Folder: (No folder|Choose folder\W*)$' 'No folder'
  }
  Choose $root 'Permissions: ' ("^" + [regex]::Escape($mode) + "\b") ("^Permissions: " + [regex]::Escape($mode) + "$") "$mode permissions"

  $promptEl = FindPrompt $root
  try { $promptEl.SetFocus() } catch {}
  Start-Sleep -Milliseconds 300
  if (-not (FocusOk $promptEl $prompt)) { Retry 'the message box lost the focus or the prompt' }

  Say @{ event = 'ready' }
  $answer = [Console]::In.ReadLine()
  if ($answer -ne 'go') { Retry 'input on the PC during the launch' }
  if (-not (FocusOk $promptEl $prompt)) { Retry 'the message box lost the focus or the prompt' }
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Step 'enter'

  # The new-session screen gives way to the session: the pickers go and the box empties.
  $started = $false; $t = Get-Date
  while (((Get-Date) - $t).TotalSeconds -lt $timeout) {
    Start-Sleep -Milliseconds 500
    $claude = ClaudeWindow
    if ($claude -eq [IntPtr]::Zero) { continue }
    $root = $A::FromHandle($claude)
    $box = FindPrompt $root
    if (-not (FindButton $root 'Environment: ') -and -not ((Norm (Value $box)) -ceq $prompt)) { $started = $true; break }
  }
  if (-not $started) { Fail 'started' "Enter was pressed but the new session didn't appear" }
  Say @{ event = 'done'; restore = (Restore $previous $claude) }
  exit 0
} catch {
  Say @{ event = 'fail'; step = 'script'; message = "the launch script failed ($($_.Exception.GetType().Name) at line $($_.InvocationInfo.ScriptLineNumber))" }
  exit 0
}
