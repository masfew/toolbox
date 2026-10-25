# Archives one session from the Claude desktop app's sidebar (Windows UI
# Automation), for archive.py. archive.py runs this hidden and checks first that
# the session is finished; this script only clicks.
#   in (stdin, one JSON line): {"title": "<the session's title>"}
#   out (stdout, one JSON line): {"event": "done"}
#        {"event": "confirm", "message": "..."}  the app asked to confirm; cancelled
#        {"event": "fail", "message": "..."}     nothing was archived
# It opens the row's "More options for <title>" menu (ExpandCollapse, no Invoke)
# and invokes its "Archive" item. No keys or mouse clicks are sent. The header of
# the open session has a "More options for <title>" button too, with the same
# menu; a button whose menu has no Archive item (an Artifact's) is skipped.
# Keep this file ASCII: Windows PowerShell 5.1 reads it in the ANSI code page.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes

$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$CT = [System.Windows.Automation.ControlType]

function Say($obj) { [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress)); [Console]::Out.Flush() }
function Fail($message) { Say @{ event = 'fail'; message = $message }; exit 0 }
function Cond($prop, $val) { New-Object System.Windows.Automation.PropertyCondition($prop, $val) }
function Both($a, $b) { New-Object System.Windows.Automation.AndCondition($a, $b) }
function Named($root, $type, $name) { $root.FindAll($TS::Descendants, (Both (Cond $A::ControlTypeProperty $type) (Cond $A::NameProperty $name))) }
function Collapse($button) {
  try { $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Collapse() } catch {}
}

$request = [Console]::In.ReadLine() | ConvertFrom-Json
$title = $request.title
if (-not $title) { Fail "no title given" }

$proc = Get-Process claude -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -eq 'Claude' -and $_.Path -match '\\WindowsApps\\|\\AnthropicClaude\\' } |
  Select-Object -First 1
if (-not $proc) { Fail "the Claude window isn't open on the PC" }
$root = $A::FromHandle($proc.MainWindowHandle)

$buttons = @(Named $root $CT::Button "More options for $title")
if ($buttons.Count -eq 0) { Fail "couldn't find it in the app's sidebar" }

foreach ($button in $buttons) {
  try { $button.GetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern).Expand() } catch { continue }
  $item = $null; $t = Get-Date
  while (-not $item -and ((Get-Date) - $t).TotalSeconds -lt 3) {
    Start-Sleep -Milliseconds 200
    $item = @(Named $root $CT::MenuItem 'Archive') | Select-Object -First 1
    if (-not $item -and @(Named $root $CT::MenuItem 'Delete').Count) { break }  # the menu is open, with no Archive
  }
  if (-not $item) {
    # The menu replaces the button's element, so find it again to close it.
    foreach ($b in @(Named $root $CT::Button "More options for $title")) { Collapse $b }
    continue
  }
  $before = @(Named $root $CT::Button 'Cancel').Count
  $item.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  # An idle session archives at once. If the app asks first (a dialog with a
  # Cancel button), cancel it: whatever it warns about needs someone at the PC.
  Start-Sleep -Milliseconds 1200
  $cancel = @(Named $root $CT::Button 'Cancel')
  if ($cancel.Count -gt $before) {
    $dialog = $cancel[-1]
    $text = $null
    try { $text = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($dialog).Current.Name } catch {}
    try { $dialog.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
    Say @{ event = 'confirm'; message = $(if ($text) { $text } else { 'the app asked to confirm' }) }
    exit 0
  }
  Say @{ event = 'done' }
  exit 0
}
Fail "its sidebar menu has no Archive item"
