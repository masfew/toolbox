# Sketch

Version 1.0.0. See the [changes](#changes) at the end.

## What It Does

A fast, simple paint app for Windows: as quick to open as Microsoft Paint, with modern tools such as layers, editable shapes, arrows and text, mark-up for screenshots, whiteboards, tabs and a screen capture key that works anywhere. It's for anyone who wants Paint's speed without its limits, and is built with Tauri 2, TypeScript, Vite and Preact.

![Sketch with a picture open, marked up with an arrow and two numbered markers, beside its tool rail, options bar and history panel](docs/screenshot.png)

## Requirements

- Windows 11, 64-bit. Windows 10 should work (without the Mica background) but is untested. macOS and Linux aren't supported.
- Python 3.9 or newer, for the installer.
- To build Sketch from this folder (the usual install, and what lets it update itself):
  - Git
  - Node 24 or newer
  - Rust from rustup, with its MSVC toolchain (the default on Windows)
  - the Visual Studio 2022 C++ build tools
  - the WebView2 runtime (built into Windows 11)
  - about 4 GB of free disk space for the build
- None of the build tools are needed to install the ready-made installer from a release instead (Install, step 2), but that copy doesn't update itself.
- Claude Code is only needed to install it by asking Claude. Sketch itself doesn't use Claude.

## Quick Start

Close Sketch if you have an older copy open, then from the root of the cloned repo (PowerShell):

```powershell
cd apps/sketch
python install.py
```

It checks the build tools, builds Sketch (3 to 10 minutes the first time), installs it and ends with **Setup complete**. Open Sketch from the Start menu.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install sketch."* With a clone already there, open Claude Code in it and say *"Install sketch."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks this is Windows (in PowerShell, `$env:OS` is `Windows_NT`) and that Python 3.9 or newer is installed. On Windows, run `Get-Command python` (PowerShell) first: if it points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python, so tell the person and wait for a yes before running `python` at all.
2. Checks the build tools: `git --version`, `node --version` (24 or newer), `rustc -vV` (its `host:` line ends in `msvc`), the C++ build tools and WebView2. `python install.py` checks all five before it builds anything and names any that are missing, so running it is also the check. If `rustc` says rustup has no default toolchain, Rust counts as missing its toolchain: the fix is `rustup default stable-msvc` (a download of about 300 MB).
3. If any are missing, asks you once, listing each with its winget command from [Install](#install), step 1, whether to install them, or to use the ready-made installer from the latest sketch release instead, which needs none of the build tools. With your yes it installs them one at a time. If a tool still isn't found afterwards, Claude Code's own PATH is out of date: restart Claude Code and ask again. For the release installer, it downloads it with `gh release download --repo github.com/masfew/toolbox --pattern "*.exe" <latest sketch-v tag>` when the GitHub CLI is installed, after asking; otherwise you download it (You do, step 1).
4. Tells you the install adds Sketch to the Start menu, makes `.sktch` files open in it, adds **Edit with Sketch** to pictures' right-click menu and lists it in Open with, and waits for your yes.
5. Waits for you to close Sketch if it's open (You do, step 3), then runs `python install.py` from `apps/sketch`, or `python install.py --setup <path to the downloaded installer>`, and checks it ends with **Setup complete**. The first build takes 3 to 10 minutes.

**You do:**

1. Only if a build tool's install shows a Windows admin prompt (the Visual Studio C++ build tools do), approve it. Only if you chose the release installer and Claude can't download it: download `Sketch_<version>_x64-setup.exe` from the latest sketch release on the [releases page](https://github.com/masfew/toolbox/releases) and tell Claude where it is. Windows SmartScreen may warn about that installer, since it isn't signed: in the blue window, choose **More info**, then **Run anyway**.
2. Only if a build tool still isn't found after Claude installed it: fully quit and reopen Claude Code, then ask Claude to install Sketch again.
3. Before Claude runs the installer: close every Sketch window, if you have an older Sketch installed.
4. Afterwards, open Sketch from the Start menu and check it starts.

## Install

1. **The build tools.** Install any that are missing, then open a new terminal (PowerShell):

   | Tool | Install with |
   |---|---|
   | Git | `winget install Git.Git` |
   | Node 24 or newer (the current LTS is) | `winget install OpenJS.NodeJS.LTS` |
   | Rust | `winget install Rustlang.Rustup` |
   | Visual Studio 2022 C++ build tools | `winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"` |
   | WebView2 runtime | `winget install Microsoft.EdgeWebView2Runtime` |

2. **Or skip building:** download `Sketch_<version>_x64-setup.exe` from the latest sketch release on the [releases page](https://github.com/masfew/toolbox/releases), and pass it to the installer with `--setup`. Windows SmartScreen may warn about it, since it isn't signed: in the blue window, choose **More info**, then **Run anyway**. A copy installed this way doesn't update itself; install a newer release the same way.
3. **Close Sketch**, if an older copy is open. The installer stops while it's running.
4. From this folder, run `python install.py` (or `python install.py --setup <path to the installer>`) in PowerShell. It:
   - checks the build tools and names the winget command for any that are missing
   - builds the release app and its installer (`npm ci`, then `npm run tauri build`)
   - when the Claude desktop app runs the install, reruns the install step outside the app's package, so Sketch lands in your real AppData folder. It says so when it does.
   - runs Sketch's installer silently. It installs for your user only (no admin prompt) in `%LOCALAPPDATA%\Sketch`, with a Start menu entry. A local build carries no download mark, so SmartScreen doesn't stop it.
   - puts the tool at `~/.claude/tools/sketch` (a link to this folder in a git clone, a copy otherwise), so `--remove` also works from there
   - saves what it installed to `~/.claude/tools/sketch.install.json`
5. Open Sketch from the Start menu.

The install is safe to rerun: it builds this folder's current version and installs it over the one there, keeping your settings and autosaves.

Sketch's installer adds it to Explorer without taking over anything:

- `.sktch` files open in Sketch.
- PNG, JPEG, WebP, BMP and GIF files get **Edit with Sketch** in their right-click menu (under Show more options on Windows 11) and Sketch in **Open with**. Sketch is also listed in Settings > Apps > Default apps, if you want it to open them by default.
- Pictures you open or save show in Sketch's jump list (right-click its taskbar button).

Uninstalling removes all of this.

## Configuration

There's no config file. Everything is set inside Sketch: Settings (Ctrl+,) holds the colour theme, keyboard shortcuts (including the capture key), where files opened from Explorer go, what happens after a capture, and the paste key. Settings, autosaves and update builds live in `%LOCALAPPDATA%\app.sketch.desktop`.

| Setting | What it does | Default | Example |
|---|---|---|---|
| Colour theme | Light or dark, or the same as Windows | Same as Windows | Dark |
| Capture Screen (keyboard shortcuts, File) | The key that captures the screen anywhere in Windows, with Sketch open or closed | None | Alt+Shift+S |
| After a capture | Copy it and show a notification, or open it in Sketch straight away | Notification | Open in Sketch |
| Press Left Shift to open the capture | A Left Shift tap within a second of a capture opens it | On | Off |
| Hide Sketch when capturing | Sketch hides itself before the screen freezes | Off | On |
| Open files from Explorer in | A new tab, or the tab showing | A new tab | The tab showing |
| Open Sketch with the clipboard picture pasted | A key that works anywhere in Windows, even with Sketch closed (it makes a **Paste into Sketch** Start menu shortcut) | None | Ctrl+Alt+V |

## Usage

### Tabs, Autosave and Windows

A window holds several pictures as tabs. New (Ctrl+N), New Whiteboard, Open, a picture dropped beside the canvas, a capture and a file opened from Explorer each open in a new tab, after the one showing; an untouched new picture is used instead when that's what's showing. The tab strip sits under the menu bar once two or more pictures are open: each tab has the picture's name, a dot while it has unsaved changes (it turns into the close button under the pointer), and a close button. Click a tab to show it, or press Ctrl+Tab and Ctrl+Shift+Tab (or Ctrl+PageDown and Ctrl+PageUp). Ctrl+F4, File > Close Tab, the × or a middle-click closes one; Ctrl+W stays Resize, as in Paint. Drag a tab along the strip to move it, or out of the window to open it in a window of its own (its undo history stays behind). Each tab keeps its own undo history, zoom and position.

While moving a selection or picked shapes, rest the pointer on another tab for half a second: Sketch switches to it and brings them along under the pointer. Shapes stay editable; pixels arrive as a floating selection to place. Each picture gets one undo step for it.

Every open picture is autosaved a few seconds after each change, and comes back after a crash or a restart, with each window's tabs back together in their order. Closing a tab or a window with unsaved changes asks Save or Don't Save, once for each picture that has them; clicking outside the box (or Esc) cancels. A capture opened by clicking its notification is the exception: it closes at once and its changes are thrown away, until it's saved to a file.

Only one Sketch runs at a time. Opening a file from Explorer while it's open opens it in a new tab of the window you used last, or in place of the picture showing (after asking about changes) if you pick "The tab showing" in Settings (Ctrl+,). The paste key and captures always get a tab of their own. Settings can also give Sketch a key that works anywhere in Windows, even when Sketch is closed, to open it with the clipboard picture pasted (it makes a **Paste into Sketch** shortcut in the Start menu).

### The Window

A tool rail on the left, menus and an options bar across the top, the picture in the middle, and a side panel on the right for layers and history (F6 or the panel button hides it). Slots with a corner triangle hold more tools: right-click, long-press or click the triangle for the flyout, or press the slot's key again to cycle. The options bar shows only the current tool's settings, and each tool remembers its settings between sessions. Sketch always opens with the Brush in black.

The window opens where you last moved or resized one, maximised if it was, after updates too. Each further window opens a step down and right. If that place is no longer on a screen, the window opens centred. Tools and options that later steps build are already in place, greyed out with the step that builds them.

Light and dark follow Windows, or pick Light or Dark under Colour theme at the top of Settings (Ctrl+,). On Windows 11 the window has the Mica background.

### Drawing Tools

- **Brush** (round, marker or highlighter, with smoothing and pen pressure), **Pencil** (hard pixels) and **Eraser** (to transparent or to colour 2). Shift+click draws a straight line from where the last stroke ended.
- **Fill** with a tolerance, "all matching", and sampling the current layer or the whole picture. Fills run in a worker and swap the old colour out of the soft edges of lines, so there's no fringe. **Colour Picker**, also Alt+click with any tool that paints.
- **Rectangle Select**, **Freehand Select** and **Magic Wand**. Moving, resizing (Shift keeps the shape) or turning a selection lifts its pixels and leaves a see-through hole; Enter or clicking outside places it, Esc puts it back, Delete clears it. Pasted pictures get the same handles. **Transparent** leaves colour 2 out, as in Paint.
- **Crop** with handles and ratios (Enter or the Crop button), plus Resize (Ctrl+W), Canvas Size, Trim to Content, and Rotate and Flip in the Image menu (they turn or flip the selection when there is one).
- **Text** stays editable on a text layer: click to type, drag to make a box that wraps, click a text again to change it, drag it to move it. Font, size, bold, italic, alignment, an outline and a background box (both in colour 2).

### Shapes, Lines and Arrows

- **Shapes** (rectangle with rounded corners, ellipse, polygon, star) and **Lines and Arrows** stay editable: they live on an object layer with text. Drag to draw (Shift keeps a shape square or round, Alt draws it from the centre, Shift turns a line in 15° steps). The outline or line is colour 1 and a shape's fill is colour 2; right-drag swaps them. Outline width, fill, solid, dashed or dotted lines, opacity, and an arrowhead (none, open, filled or dot) at either end.
- **Picking**: click a shape or line with the Shapes, Lines or Select tool to pick it, Shift+click to pick more. Drag to move, handles to resize or turn a shape, a line's ends to move them and its middle handle to bend it. The options bar shows the picked shape's settings and changes it. Delete removes it, arrows nudge it, Ctrl+D duplicates, Ctrl+C and Ctrl+V copy and paste shapes, Ctrl+Shift+] and [ bring to front and send to back. An unfilled shape is picked by its outline, so you can draw inside it.
- **Smart guides** show while moving, resizing and drawing, and snap to other shapes, text and the picture's edges and centre, and to equal gaps. Hold Ctrl to skip them, or turn them off in View > Snap to Shapes. With two or more picked, the options bar has Align and Space Evenly buttons.
- **Turning into pixels**: painting while a shape layer is current paints underneath it, and says so the first time with a button to rasterize the layer. Image > Rasterize Layer, Edit > Rasterize Shapes and Image > Flatten turn shapes into pixels. PNG, JPEG, WebP and BMP flatten when saved; `.sktch` keeps everything editable.

### Layers

The Layers section of the side panel starts closed, so a picture is one layer until you want more. Open it (or press Ctrl+Shift+N for a new layer) to see every layer, top first, with a small picture of each. Click a layer to work on it, double-click its name to rename it, and drag it up or down to move it (Ctrl+] and Ctrl+[ do the same). The eye hides a layer and the lock stops it being changed: pixel tools, selections, adjustments and picking shapes all leave a locked or hidden layer alone and say why. Under the list are the current layer's opacity and buttons for a new layer, moving it, Merge Layer Down (Ctrl+E) and deleting it. A picture always keeps at least one pixel layer. Every change to a layer is a history step. **Paste onto New Layer** in the Edit menu makes each paste a layer of its own (it's off at first); a paste onto a locked or hidden layer gets a new layer either way.

### Mark-Up

The Mark-Up slot holds tools for screenshots. Everything they draw is an object on a layer called Mark-up (or the current object layer), so it can be picked, moved, resized, turned, restyled and deleted afterwards, like a shape.

- **Highlighter**: draw over text; Shift draws straight. Its colours (yellow, green, blue, pink, orange) darken what's under them, so text stays readable.
- **Blur** and **Pixelate**: drag a box over anything to hide. Both are strong enough by default that text under them can't be read or sharpened back. They hide whatever is under them, on every layer below.
- **Numbered Marker**: click to place 1, 2, 3 and so on. Deleting one renumbers the ones after it. Number on the options bar sets the next one.
- **Callout**: press on what to point at and drag to where the bubble goes (or just click), then type. Moving the bubble keeps the point; drag the round handle to move the point. Callouts are text, so the Text tool edits them too.
- **Spotlight**: drag a rectangle or ellipse to keep bright; everything else dims. Several spotlights on a layer share one dimming.

### Adjust

The Adjust menu changes the selection, or the whole current pixel layer when nothing is selected. **Brightness and Contrast** and **Hue and Saturation** open a small dialog beside the picture, which shows the change live as the sliders move (double-click a slider to reset it). **Black and White**, **Invert Colours** (Ctrl+Shift+I) and **Auto Level** (Ctrl+Shift+L) happen at once. Auto Level stretches the picture to full black and white with one stretch for all colours, so greys stay grey.

### Whiteboards

**File > New Whiteboard** (Ctrl+Alt+N) starts an endless board for diagrams and notes instead of a picture. It's white with a light dot grid, and has no edges: pan and draw in any direction and the board grows to hold whatever you draw. Every tool works on it except the ones for a picture's size (Crop, Resize, Canvas Size, Trim to Content), which are hidden; Rotate and Flip turn only a selection. Ctrl+0, or the fit button in the status bar, zooms to fit everything on the board. Fill fills inside closed outlines only, since empty space on a board never ends. Pastes land in the middle of the view, and a picture dropped from Explorer lands where you drop it.

Save a whiteboard as `.sktch` to keep it endless and editable. Saving it as PNG, JPEG, WebP or BMP, or copying it (Ctrl+C with nothing selected, or Ctrl+Shift+C), gives a picture of what's on the board on white, cropped to the drawing plus a small margin. The dot grid is never in it. A selection copies just the selection. Painted pixels can reach 16384 px across in each direction; shapes and text can go anywhere.

### Mouse Speed

The mouse button at the bottom of the tool rail, above the command palette's search button, opens a slider that sets a slower mouse speed (to as little as a quarter of its speed, never faster than normal) for steadier drawing and handwriting. The slower speed applies only while you hold **Left Ctrl** with a Sketch window in focus, whether you're lining the pointer up or drawing; the rest of the time, drawing included, the mouse keeps its own speed. Sketch puts your own speed back the moment you let go of Left Ctrl, another window takes focus, or Sketch minimises or closes. Right Ctrl does nothing. Holding Ctrl while you drag a shape or line also skips snapping, as it always has. While the speed isn't normal the button turns blue with a small notice icon. Reset to Normal in the slider, double-clicking the slider, or Reset Mouse Speed in the command palette sets it back. The setting is remembered between sessions.

Windows has one mouse speed for the whole PC, so Sketch never saves its change to your Windows settings: if Sketch ever crashed with the slower speed in force, signing out or restarting would bring your own speed back, and so does the next start of Sketch.

### Screen Capture

The capture keys (below), File > Capture Screen or the command palette freeze the screen and dims it, with a toolbar at the top of the screen the pointer is on:

- **Area** (picked at first): drag to capture an area. A click without a drag does nothing.
- **Window**: the window under the pointer is highlighted; click to capture it.
- **Full screen**: the screen under the pointer is highlighted; click to capture it.
- **Close** (or Esc, or a right-click) cancels.

F or Enter captures the screen under the pointer in any mode. The toolbar hides while an area you're dragging comes near it, and stays in view in Window and Full screen modes. It's never in the capture either way, since the screen was frozen before it showed. The blue outline sits just outside a dragged area, and just inside a highlighted window or screen, so it never spills onto the next monitor; it's never in the capture either. Sketch stays on screen and can be captured like any other window; turn on **Hide Sketch when capturing** in Settings to have it hide first instead.

The capture goes on the clipboard, and a Windows notification says so, with a small picture of it. Nothing else opens, so you can paste it straight into another app. Clicking the notification opens the capture in Sketch on a canvas its own size with the Brush in red ready, and brings it to the front. Tapping **Left Shift** within a second of the capture does the same, so there's no waiting for the notification or reaching for the mouse; a Shift pressed later, held, or as part of typing works as normal. **Press Left Shift to open the capture** in Settings turns that off.

A capture's edges are open, as in the Snipping Tool: arrows, writing, circles and brush strokes can run past it onto the grey space around it without being cut off. Copying it (Ctrl+Shift+C or the Copy button), or saving it as PNG, JPEG, WebP or BMP, gives the capture with everything drawn round it, see-through past the capture's edges (white in JPEG and BMP); with nothing drawn outside, that's the capture exactly. The status bar shows the capture's own size, and pointer positions count from its top-left corner. A capture has no size handles; Crop starts from the capture itself, and Resize and Canvas Size first make everything drawn round it part of the picture. This is only for captures: other pictures keep their edges, as in Paint.

The notification goes after 3 seconds and isn't kept in the notification centre: a capture not opened by then is one you only wanted on the clipboard, which it stays on. A newer capture replaces the older one's notification. With Sketch closed, a hidden Sketch starts with the capture as the notification shows, so the click shows it within a few hundredths of a second instead of starting Sketch (about a third of a second); it closes with the notification if you don't click. If Windows won't show the notification (notifications turned off for Sketch), the capture opens in Sketch at once instead. **After a capture** in Settings can open every capture in Sketch straight away instead.

The **Copy** button beside the camera copies the whole picture with everything drawn on it, merged into one PNG with its transparency, as Ctrl+Shift+C does, and says Copied for a moment. On a whiteboard it copies what's on the board, as an export would, and on a capture the capture with everything drawn round it. The picture stays editable.

#### Capture Keys

Capture has one shortcut: **Capture Screen** under File in Settings' keyboard shortcuts (Ctrl+,). Its keys work anywhere in Windows, with Sketch open or closed. They can be **Print Screen**, Print Screen with Ctrl, Alt or Shift, or two of Ctrl, Alt and Shift with a letter, number or F key (like Alt+Shift+S). Keys another app already uses are refused with a message saying so. Windows 11 uses Print Screen for its own screen capture until you turn off "Use the Print screen key to open screen capture" (Settings > Accessibility > Keyboard); Sketch says so, with a button that opens that page.

A small helper, `sketch-capture.exe` (installed beside Sketch, under 1 MB), holds the keys and shows the same capture overlay and notification as Sketch, without starting Sketch. Pressed while Sketch is in front, the keys go to Sketch, which hides itself first if **Hide Sketch when capturing** is on. Whenever the shortcut is set, the helper starts when you sign in to Windows and keeps running after Sketch closes, so the keys always work and a notification can be clicked any time; it holds about 3 MB of memory of its own while it waits. Removing the shortcut stops the helper and takes it out of sign-in. **After a capture** in Settings picks between a notification and opening the capture in Sketch. Captures waiting for their notification are kept in the data folder's `captures` folder, and anything there older than a day is deleted.

Until October 2026 the keys lived on a **Capture with Sketch** shortcut in the Start menu. Sketch moves keys from that shortcut to the helper the first time it starts, and deletes the shortcut. Until 22 Oct 2026 Settings also had a separate in-app shortcut for Capture Screen and a **Keep capture ready when Sketch is closed** switch; an in-app shortcut set then becomes the capture shortcut when Sketch starts, and the helper now always stays ready.

### Shortcuts

Every action lives in one command list (`src/app/commandList.ts`) that feeds the menus, the shortcuts, the command palette and the shortcuts sheet. Shortcuts can be changed in Settings (Ctrl+,); `?` shows them all.

| Keys | Action |
|---|---|
| M, C, P, B, E, G, I, T, U, A | Select, Crop, Pencil, Brush, Eraser, Fill, Colour Picker, Text, Shapes, Lines and Arrows |
| Ctrl+D, Ctrl+Shift+], Ctrl+Shift+[ | Duplicate, bring to front, send to back (picked shapes) |
| Ctrl+Shift+N, Ctrl+E, Ctrl+] and Ctrl+[ | New layer, merge layer down, move the current layer up or down |
| Ctrl+Shift+I, Ctrl+Shift+L | Invert colours, auto level |
| Ctrl while dragging | Don't snap to guides |
| Ctrl+K | Command palette: find any action by name |
| ? | Keyboard shortcuts sheet |
| Ctrl+, | Settings (change shortcuts) |
| Ctrl+N, Ctrl+Alt+N, Ctrl+O, Ctrl+S, Ctrl+Shift+S | New, New Whiteboard, Open, Save, Save As |
| Ctrl+Z, Ctrl+Y (or Ctrl+Shift+Z) | Undo, Redo |
| Ctrl+V | Paste (grows the canvas if needed) |
| Ctrl+C, Ctrl+Shift+C | Copy pasted image or picture, copy whole picture (also the Copy button at the right of the menu bar) |
| Ctrl+A, Ctrl+X, Delete | Select all, cut, clear the selection (on a screen capture with nothing selected, Ctrl+X copies the whole capture and closes it) |
| Enter, Esc, arrows (Shift for 10 px) | Place, cancel or nudge a selection or pasted image; Esc lets go of picked shapes, arrows nudge them |
| Ctrl+Shift+X, Ctrl+W | Crop to selection, resize |
| Shift+click | Straight line from the last stroke |
| Alt+click | Pick a colour |
| Ctrl+wheel or pinch, Ctrl+= and Ctrl+- | Zoom |
| Wheel, Space+drag, middle drag | Pan |
| Ctrl+0, Ctrl+1 | Fit to window, 100% |
| Ctrl+' | Pixel grid on or off (shows from 800%) |
| [ and ], Alt + right-drag | Tool size |
| X | Swap colours |
| F6 | Side panel |
| Alt + menu letter | Open a menu (Alt+F for File) |

## How It Works

The install folder, `%LOCALAPPDATA%\Sketch`, holds a small launcher as `sketch.exe`, `current.json` naming the version to open, and one `app-<commit>` folder per version (the current one and the one before it are kept). The Start menu, taskbar pins, Explorer's "Edit with Sketch" and the capture key's sign-in entry all go through the launcher. If the newest version can't open, the launcher opens the one before and Sketch says so. The capture helper, `sketch-capture.exe`, runs from the version folder whenever a capture key is set, with a sign-in entry under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.

Settings, autosaves, waiting captures and update builds live in `%LOCALAPPDATA%\app.sketch.desktop`, apart from the install folder, so uninstalling never takes them.

`install.py` changes nothing else. It builds in this folder (`node_modules`, `dist` and `src-tauri\target`, all ignored by git), runs Sketch's own NSIS installer, and puts this tool at `~/.claude/tools/sketch` with a record of the install in `~/.claude/tools/sketch.install.json`, so `--remove` works from there even if this folder is gone.

### Updates

A Sketch built from a git clone updates itself from that clone, silently, the way Discord and Slack do. The build stamps in which repo and which folder in it Sketch came from, so this works wherever the clone and Sketch's folder are. While Sketch is open, it checks the clone's `origin/main` at start, every 5 minutes, when its window gets focus and whenever a build starts or finishes (the build tells a running Sketch straight away), for a newer commit that changes Sketch's folder. `origin/main` moves when you `git pull` (or push your own commits), so pulling is all an update needs. When Sketch finds a newer commit, it builds it in the background, in a git worktree of its own under `%LOCALAPPDATA%\app.sketch.desktop\build` (never in your clone, so uncommitted work never ships), and the build keeps running if you close Sketch. The finished build goes into a new version folder beside the running one; nothing is installed and the running Sketch isn't touched. The next time Sketch opens, it's the new version, with no wait.

The version number (like v1.0.12) sits at the bottom right of the status bar and at the bottom of Settings; its last part counts the commits that changed Sketch's folder, so it goes up with every update. While a new version is building, a small spinning circle sits just in front of it. Once it's waiting, a small circle with an up arrow sits just in front of the version number, and the Help menu has **Restart to Update**, which keeps every open picture and window, restarts, and brings them back on the new version. A Sketch left open restarts into it by itself once nobody has touched the keyboard or mouse for 5 minutes (or the screen is locked), as long as no Sketch window is in front and nothing is half done (a dialog, typing, a capture waiting for its notification). Its windows come back with their pictures, in the same places, minimised if they were, without taking the focus. A failed build is tried again after the next commit.

Updates need the same build tools as the install, on the PATH. The build log is `%LOCALAPPDATA%\app.sketch.desktop\build\build.log`. A Sketch installed from a release's installer has no clone to update from, so it never checks.

### Code Layout

- `src/engine` document and layers, whiteboards (`board.ts`: growth, content bounds, export area), text objects and callouts, shapes and lines (`shapes.ts`), mark-up (`marks.ts`), adjustments (`adjust.ts`), tile-based undo, history, commands (crop, resize, rotate, flip, rasterize, flatten, layers), flood fill, pixel helpers
- `src/view` viewport maths, renderer, mouse and pen input
- `src/io` file formats, encoder worker, BMP, `.sktch`
- `src/platform` Tauri calls with browser fallbacks
- `src/app` app state, actions, a whiteboard growing with the view kept still (`board.ts`), autosave and recovery (`recovery.ts`), the mouse speed slider (`mouse.ts`), launches and windows (`launch.ts`), updates (`update.ts`), layer actions (`layers.ts`), the Adjust menu (`adjust.ts`), the command list and key bindings, tool state, colours, saved settings
- `src/tools` the tool list with each tool's options (`registry.ts`), strokes, fill and its worker, selection, the transform box, crop, text, shapes and lines (`shapes.ts`), the mark-up tools (`marks.ts`) and callouts (`callout.ts`), and snapping and lining up (`snap.ts`)
- `src/ui` Preact components: menu bar, tool rail, options bar, colour popover, side panel with the layers panel, dialogs, palette, shortcuts sheet, settings
- `src-tauri` Rust side: file reading and writing, clipboard, URL fetch, start-up probe, windows and launches (`lib.rs`), one running Sketch (`instance.rs`), the mouse speed (`mouse.rs`), screen capture and its overlay (`capture.rs`), its notification (`note.rs`), the capture helper `sketch-capture.exe` (`helper.rs`, started by `src/bin/sketch-capture.rs`), the launcher (`src/bin/sketch-launcher.rs`) and the install layout (`layout.rs`), autosave slots (`recovery.rs`), updates and the quiet restart (`update.rs`), jump list and the paste and capture keys (`shell.rs`), and the installer's launcher layout, Explorer integration and capture helper (`windows/hooks.nsh`)
- `scripts` the checks, the build stamp (`build-info.mjs`, which also writes the installer's `src-tauri/windows/version.nsh`), the update build (`update-build.mjs`) and developer updates after a push (`dev-update.mjs`, started by the repo's `.github/hooks/pre-push`)

## Development

### Run It

From the `apps/sketch` folder (PowerShell):

```powershell
npm install
npm run tauri dev
```

The drawing code also runs in a plain browser for testing: `npm run dev`, then open http://127.0.0.1:1420. Native features (file dialogs, Explorer file paste, clipboard with transparency, drag and drop of files from Explorer) only work in the Tauri app.

### Build and Check

From the `apps/sketch` folder (PowerShell):

```powershell
npm test                 # unit tests (history, viewport, tiles, BMP encoder, keys, search, colours, tools, fill, selection box, text, shapes, snapping, mark-up, adjustments, whiteboards)
npm run tauri build      # release app and NSIS installer
npm run check:size       # installer must be under 15 MB
npm run check:startup    # median start-up must be under 1 second
npm run check:native     # drives the built app: paste, copy, shapes copy and paste, file dialogs, fill, drag and drop, close prompt, Mica, colour theme, saved settings, autosave and recovery, tabs, more than one window, mouse speed, screen capture, the capture helper, the Copy button
npm run check:speed      # 4K paste under 200 ms, brush at 60 fps on 4K, and timings of mark-up, copy and autosave
npm run check:fuzz       # random edits with undo and redo for 3 minutes (add 60 for the hour-long run)
npm run check:update     # silent updates in a scratch install folder against a throwaway clone: the installer's layout, staging, the ready icon, the quiet restart, Restart to Update, the launcher
npm run perf             # times every everyday action against its budget and the last full audit; npm run perf -- brush save for just some
```

The full performance audit's process, budgets and results are in [docs/performance-audit.md](docs/performance-audit.md).

CI runs the first four on `windows-latest` when anything in this folder changes (`.github/workflows/sketch.yml` at the repo's root).

The `check:` scripts after `check:startup` run locally only. They open the release app, drive its page through WebView2's debugging port (127.0.0.1 only) and fill the Open and Save dialogs with window messages, so they don't move the mouse. They replace whatever is on the clipboard. The capture checks cover the screens with the capture overlay for a moment and show a magenta test window; they drive the overlay with window messages, not the mouse. They never change your mouse speed (the app changes a stand-in file instead). Each gives the app its own data folder (`SKETCH_DATA_DIR`), so they never touch your autosaves or updates or reach a Sketch you have open. The helpers are in `scripts/native-driver.mjs`. `check:update` lays out a scratch install folder of its own and never touches the installed Sketch, its shortcuts or the registry. Its quiet restart step waits for 2 seconds with no keyboard or mouse input, so leave the PC alone while it runs.

### Developer Updates

While you work on Sketch, a push can update your installed Sketch straight away, so the next time you open it you're already testing what you just pushed, with no wait for the in-app update. In a clone where the repo's git hooks are on (`git config core.hooksPath .github/hooks`, as the root README's "Before You Push" says), each push of `main` to `origin` hands the commit to `scripts/dev-update.mjs` once the pre-push check has passed. Otherwise turn them on once per clone, from this folder (PowerShell):

```powershell
npm run dev:hooks
```

From then on, each push of `main` to `origin` starts the update in the background: once the push has landed, it builds the newest commit that changes Sketch's folder into a new version folder of the installed Sketch, exactly as the in-app update does (the same build folder, lock and log, so the two never build at once). The push itself doesn't wait, the build keeps going after the terminal closes, and a warm build takes about a minute and a half. A Sketch that's open when it finishes shows its update icon and restarts into it as usual. `npm run dev:update` does the same by hand, without a push, and also retries a build that failed.

Nothing of this is in the app or its installer; it only runs in a clone with the hooks turned on, and does nothing without an installed Sketch. Its messages go to `%LOCALAPPDATA%\app.sketch.desktop\build\dev-update.log`, beside `build.log`. If the clone already has hooks of its own (`core.hooksPath`), `dev:hooks` leaves them alone; call `.github/hooks/pre-push` from yours instead.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `sketch-v<version>`, with its notes, a zip of this folder and the installer.

A Sketch built from a clone updates itself after `git pull` ([Updates](#updates)), so there's nothing to rerun. To update by hand instead, or after the build tools change, pull and rerun the install from the root of the cloned repo (PowerShell):

```powershell
git pull
cd apps/sketch
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell):

```powershell
git fetch --tags
git checkout sketch-v1.0.0
cd apps/sketch
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too, and Sketch stops updating itself until you're back on `main` (it only updates from commits on `origin/main`). To return to the latest version, run `git checkout main` and `git pull`, then rerun the install.

With a release's installer, download the newer one and run `python install.py --setup <path to it>` again.

If Sketch's folder moves or is renamed (for example when the repo is reorganised), rerun `python install.py` from the new folder. The new build records the new folder, and its first update makes the build worktree again for it.

## Uninstall

Close Sketch, then from this folder (PowerShell):

```powershell
python install.py --remove
```

If this folder is gone, run the same command from `~/.claude/tools/sketch` instead, or uninstall Sketch from Settings > Apps.

This runs Sketch's own uninstaller silently, which removes the program, its Start menu entry, file types, Explorer menu items, jump list and the capture helper's sign-in entry, then removes `~/.claude/tools/sketch` and its install record. Your settings, autosaves and update builds stay in `%LOCALAPPDATA%\app.sketch.desktop`; delete that folder yourself if you don't need them. The build output in this folder (`node_modules`, `dist`, `src-tauri\target`) also stays; `git clean -fdx` in this folder removes it.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `FAILED: Sketch is built from source, and these build tools are missing` | A build tool isn't installed, or the terminal was opened before it was | Install what it names with the winget command it gives, open a new terminal, and rerun. Or install a release's installer with `--setup` |
| `FAILED: Sketch is running` | The installer can't replace a running Sketch | Close every Sketch window and rerun. Unsaved pictures come back from autosave |
| `rustc` says rustup has no default toolchain, or the install says Rust is missing its MSVC toolchain | rustup is installed but no toolchain is chosen | Run `rustup default stable-msvc`, then rerun |
| `cargo` or `rustc` not found during the build | Rust was installed after the terminal opened | Open a new terminal. The installer adds `%USERPROFILE%\.cargo\bin` to the build's PATH by itself |
| `link.exe` not found, or `LNK1181` | The Visual Studio C++ build tools are missing or incomplete | Run the build tools' winget command from [Install](#install), step 1 |
| The update icon never shows after `git pull` | The pull brought no commit that changes Sketch's folder, or the build failed | See `%LOCALAPPDATA%\app.sketch.desktop\build\build.log`. A failed build is tried again after the next commit, or run `npm run dev:update` from this folder |
| Sketch doesn't start from the Start menu after an install run from the Claude desktop app | The install landed in the app's private copy of AppData | Rerun `python install.py`: it reruns itself outside the app's package. Never run the NSIS installer straight from a Claude session |
| Print Screen can't be set as the capture key | Windows 11 uses Print Screen for its own screen capture | Turn off "Use the Print screen key to open screen capture" in Settings > Accessibility > Keyboard; Sketch's Settings has a button that opens that page |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.0.0: First release in the toolbox. Updates follow the clone and folder Sketch was built from, wherever they are; a build worktree left by another clone is made again instead of failing. `install.py` builds and installs it, or installs a release's installer with `--setup`, and releases attach the installer.
