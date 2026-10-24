# Wispr Mute

Version 1.0.0. See the [changes](#changes) at the end.

## What It Does

A small background helper for [Wispr Flow](https://wisprflow.ai) on Windows, with a tray icon to control it. It replaces Wispr Flow's own "Mute music while dictating": the moment Wispr Flow opens the microphone it mutes your audio, and the moment the mic closes it unmutes it, with a whitelist of apps (Discord by default) that stay audible while you dictate. It also keeps Wispr Flow's tray icon pinned next to the clock across Wispr Flow updates.

Why: on Windows, Wispr Flow lowers each app's volume one by one and puts each back afterwards. Apps it has no saved volume for, including any that start playing mid-dictation, are skipped, and restoring can lag by seconds ([Wispr Flow's docs](https://docs.wisprflow.ai/articles/7231650589-auto-mute-music-while-dictating-on-macos-how-audio-detection-works)). Wispr Mute mutes everything within about 10 ms of the mic opening and never touches Wispr Flow itself.

Two controls, both in the tray icon's flyout:

- **Muting / Audible:** whether dictating mutes anything at all.
- **The whitelist:** apps that can stay audible while you dictate, each switched on or off. With Discord on and Spotify off, dictating mutes everything, Spotify included, except Discord, so people in a call stay audible.

The tray icon is Wispr Flow's own icon with a badge:

| Badge | Meaning |
|---|---|
| Red, muted speaker | Muting: dictating mutes everything (except any whitelisted apps kept audible) |
| Grey speaker | Audible: muting is switched off |
| Amber **!** | The helper isn't running, so nothing is muted |

## Requirements

- Windows 10 or 11. Tested on Windows 11. macOS and Linux aren't supported: the helper uses Windows' Core Audio and tray APIs.
- [Wispr Flow](https://wisprflow.ai), installed for your user (the default), so it's at `%LOCALAPPDATA%\WisprFlow`.
- Python 3.9 or newer. Standard library only: nothing else to install.
- Claude Code is only needed to install it by asking Claude. Wispr Mute itself doesn't use Claude.

## Quick Start

From the root of the cloned repo (PowerShell):

```powershell
cd apps/wispr-mute
python install.py
```

It ends with **Setup complete**, and the Wispr Mute tray icon appears (possibly in the **^** overflow). Then turn off Wispr Flow's own muting, as [Install](#install) step 3 says.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install wispr-mute."* With a clone already there, open Claude Code in it and say *"Install wispr-mute."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks this is Windows, that Python 3.9 or newer is installed, and that Wispr Flow is installed (`%LOCALAPPDATA%\WisprFlow\Wispr Flow.exe` exists). It asks before installing Python if it's missing, with the command from [Install](#install) step 1. It can't install Wispr Flow for you.
2. Tells you the install adds two Startup shortcuts, so Wispr Mute starts every time you sign in, and starts it now, and waits for your yes.
3. Runs `python install.py` from `apps/wispr-mute`, and checks it ends with **Setup complete**.
4. Runs `python wispr_mute.py status` from `apps/wispr-mute`, and checks it says the helper and the tray icon are running.

**You do:**

1. In Wispr Flow, turn off **Settings → System → Sound → Mute music while dictating**, so the two don't both mute.
2. Drag the Wispr Mute tray icon out of the **^** overflow next to the clock. Or turn it on under **Settings → Personalization → Taskbar → Other system tray icons**, where it's listed as **Python**.
3. Dictate something with music playing, to check it goes silent and comes back.

## Install

1. **Python 3.9 or newer.** Check with `python --version`. If it's missing, run `winget install Python.Python.3.13`, then open a new terminal.
2. From this folder, run `python install.py` (PowerShell). It:
   - checks that Wispr Flow is installed, and stops if it isn't
   - puts the tool at `~/.claude/tools/wispr-mute`. In a git clone that's a link to this folder (a directory junction, which needs no admin rights), so a `git pull` updates the tool. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - stops a running helper and tray icon, asking them to stop on their own first so the helper unmutes anything it muted
   - adds two shortcuts to your Startup folder, **Wispr Mute** (the helper) and **Wispr Mute tray** (the tray icon), which run them at sign-in through `~/.claude/tools/wispr-mute` with `pythonw`, so they have no window, and starts both now
   - when the Claude desktop app runs the install, reruns itself outside the app's package, so the shortcuts land in your real Startup folder. It says so when it does.
   - saves what it installed to `~/.claude/tools/wispr-mute.install.json`
3. In Wispr Flow, turn off **Settings → System → Sound → Mute music while dictating**.
4. Windows 11 puts new tray icons in the **^** overflow. Drag the Wispr Mute icon next to the clock, or turn it on under **Settings → Personalization → Taskbar → Other system tray icons**, where it's listed as **Python** (the tray icon runs under `pythonw.exe`).

The install is safe to rerun, and restarts both. Your settings in `~/.claude/wispr-mute/` are kept.

## Configuration

Settings are in `~/.claude/wispr-mute/config.json`, normally changed through the flyout. The helper creates the file the first time you change something; until then it uses the defaults. Every setting except `poll_ms` is reread each time the mic opens, so changes apply from the next dictation.

| Setting | What it does | Default | Example |
|---|---|---|---|
| `mute_audio` | Mute audio while Wispr Flow has the mic open (the flyout's Muting/Audible switch) | `true` | `false` |
| `whitelist` | Apps that can stay audible. `enabled` keeps the app audible while muting; `name` and `path` are filled in when known, for the flyout's tooltip and icon. A plain exe name (`"Spotify.exe"`) also works and counts as on | Discord, on | `[{"exe": "Discord.exe", "enabled": true}, {"exe": "Spotify.exe", "enabled": false}]` |
| `max_mute_seconds` | Unmute after this long in one mic session (0 is never). Set it if Wispr Flow's meeting recorder would otherwise mute your speakers for a whole call | `0` | `600` |
| `poll_ms` | How often the fallback registry check runs without a change notification. The microphone itself is checked every 50 ms regardless. Needs a restart (`python install.py` again, or `stop` then `run`) | `500` | `1000` |

## Usage

**Left-click** the tray icon to open the flyout, centred above the icon:

- **The switch** (the big square): **Muting**, filled in your Windows accent colour with a muted speaker, or **Audible**, grey with a playing speaker. Click to flip it.
- **The whitelist** (the box beside it): one square per app, in the app's brand colour with its logo (or the app's own icon) when it's kept audible, grey when it's muted with the rest. Click an app to switch it. Hover for its name. Right-click it (or select it and press Delete) to remove it. While Audible it dims, but stays clickable so you can set it up.
- **+** adds an app: pick one of the apps playing audio right now, or **Browse for an app...** to pick any `.exe`. It's added switched on.
- **The footer** shows an amber **Start helper** link when the helper isn't running.
- It closes on a click elsewhere, Esc, switching apps, or another click on the icon. Keyboard: Tab or the arrow keys move, Enter or Space picks.

**Right-click** the tray icon for a plain menu: **Muting while dictating**, each whitelisted app under **Keep audible**, **Start helper** when it's down, and **Quit tray icon**.

**Muting yourself in Discord** needs nothing from Wispr Mute: in Discord, add a **Push to Mute** keybind on **Ctrl+Win** (Wispr Flow's push-to-talk hotkey). Keep **Input Mode** on **Voice Activity**. It doesn't cover Wispr Flow's hands-free mode.

### Commands

From this folder, `python wispr_mute.py <command>` (PowerShell):

| Command | What it does |
|---|---|
| `status` | Shows whether the helper and the tray icon are running, Muting or Audible, the whitelist, Wispr Flow's latest mic use, the default output and its mute state, the Windows ducking setting, and every app's volume |
| `mute` | Shows whether dictating mutes audio. `mute on` or `mute off` switches it from the next dictation |
| `repair-audio` | Lists apps that are muted or at 0% on any output device, and what each would be restored to. Changes nothing |
| `repair-audio --fix` | Restores them: unmutes, and sets silenced apps back to their last saved volume (100% if none) |
| `watch` | Prints Ctrl+Win and mic changes live, with the delay between them. Ctrl+C to quit |
| `run` | Runs the helper in the foreground, logging to the console too. The Startup shortcut adds `--at-login` (see [Keeping Wispr Flow Running](#keeping-wispr-flow-running)) |
| `test-notification` | Shows the "Wispr Flow didn't start - retrying" notification |
| `stop` | Stops the running helper |

`python tray.py stop` closes the tray icon. Rerun `install.py`, or the **Wispr Mute tray** Startup shortcut, to bring it back.

## How It Works

### Muting

- Every 50 ms the helper asks Core Audio which processes have an active capture session on any microphone (about 0.5 ms a check; the helper uses under 0.5% of one CPU core). Wispr Flow is dictating while one of its processes has one. Only the running Wispr Flow exe counts.
- Windows also logs every desktop app's microphone use under `HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged`. Since a Windows update in October 2026, Wispr Flow's dictations no longer show up there, so it's only a fallback, reread when it changes or every `poll_ms`.
- **No whitelisted app switched on:** on mic open it mutes the whole default output device (`IAudioEndpointVolume`, about 6 to 10 ms), so nothing can slip through, and on mic close it unmutes that same device. A device that was already muted, or that you unmute by hand mid-dictation, is left alone.
- **Some switched on:** on mic open it mutes each app's own session (the per-app slider in the volume mixer) on every output device, default output first, except the apps switched on (about 10 ms for the default output, 15 to 25 ms for all of them). While you dictate it rechecks every 250 ms and mutes apps that start playing. On mic close it unmutes only the sessions it muted.
- Windows remembers an app's mute even after the app quits. So if an app quits while muted, the helper unmutes it the moment it plays again.
- Before muting, it writes `muted-device.json` listing what it's about to mute. If the helper dies mid-dictation, the next start finds the file and restores everything.
- Every 30 seconds it saves each app's last audible volume, so `repair-audio --fix` can put a silenced app back at its real level instead of 100%.

### Keeping Wispr Flow's Tray Icon Pinned

Wispr Flow installs each update into a new folder (`%LOCALAPPDATA%\WisprFlow\app-<version>`), and Windows 11 remembers a tray icon's pinned state per exe path, so after every update Wispr Flow's icon falls back into the **^** overflow. Every 30 seconds the helper looks at the running Wispr Flow exe. If its entry under `HKCU\Control Panel\NotifyIconSettings` isn't pinned, it sets `IsPromoted = 1` and asks Wispr Flow to re-add its icon, so a new version is pinned within about 30 seconds of its icon appearing. Each exe is handled once per helper run, so an icon you drag into the overflow by hand stays there until the next sign-in.

### Keeping Wispr Flow Running

At sign-in (the Startup shortcut runs `run --at-login`), if Wispr Flow isn't running after 2 minutes, the helper shows a **Wispr Flow didn't start - retrying** notification and starts it, then shows **Wispr Flow started** or **Wispr Flow retry failed**. The failure notification stays on screen until you dismiss it. Notifications appear as **Wispr Mute** with Wispr Flow's icon, through an app ID the helper registers under `HKCU\Software\Classes\AppUserModelId\Toolbox.WisprMute`. Running `install.py` or `run` by hand never starts Wispr Flow.

### Files

| Path | What it is |
|---|---|
| `wispr_mute.py` | The helper and its commands |
| `core_audio.py` | Core Audio through ctypes: capture sessions, device and per-app mute and volume |
| `tray_pin.py` | Pinning Wispr Flow's tray icon, the sign-in retry and the notifications |
| `tray.py`, `flyout.py`, `tray_icons.py`, `app_icons.py`, `win32.py` | The tray icon, its flyout and menu, and the icons they draw. The tray icon is drawn from Wispr Flow's installed `TrayIconWindows.png` and the whitelist's icons from each app's own exe, so no images are shipped |
| `~/.claude/wispr-mute/config.json` | Your settings |
| `~/.claude/wispr-mute/helper.log` | One block per dictation (mic open, what was muted, mic closed, what was unmuted), each tray icon pin and the sign-in retry. Rotates at 1 MB |
| `~/.claude/wispr-mute/tray.log` | Tray icon starts, changes made from the flyout or menu, and errors. Rotates at 200 KB |
| `~/.claude/wispr-mute/muted-device.json` | Only while the helper has something muted: what to restore |
| `~/.claude/wispr-mute/app-volumes.json` | Each app's last audible volume |
| `~/.claude/wispr-mute/icons/` | Generated whitelist icons. Safe to delete; they're regenerated |

The helper and the tray icon run as separate processes, so a problem in the tray icon can't affect muting. The tray icon only reads and writes the config, and notices changes made elsewhere within a second.

Everything the install adds points at `~/.claude/tools/wispr-mute`, never at the folder you installed from: both Startup shortcuts run the scripts there, from `~/.claude` as their working folder. Only `~/.claude/tools/wispr-mute` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/wispr-mute.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `wispr-mute-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install, which restarts the helper and the tray icon (PowerShell):

```powershell
git pull
cd apps/wispr-mute
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell):

```powershell
git fetch --tags
git checkout wispr-mute-v1.0.0
cd apps/wispr-mute
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `wispr-mute` folder inside it. The install copies the tool to `~/.claude/tools/wispr-mute`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed, the install keeps working as it is. Rerunning `python install.py` from the new folder points `~/.claude/tools/wispr-mute` there and takes out anything stale.

## Uninstall

From the tool's folder (PowerShell):

```powershell
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/wispr-mute` instead.

This stops the helper and the tray icon, and removes the Startup shortcuts, `~/.claude/tools/wispr-mute` and its install record. It leaves your settings and logs in `~/.claude/wispr-mute/`; delete that folder yourself if you don't need it. Turn Wispr Flow's own muting back on if you want it, under **Settings → System → Sound → Mute music while dictating**.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Nothing gets muted when you dictate | The helper isn't running, or isn't seeing Wispr Flow's mic | Check the tray badge or `python wispr_mute.py status`. Check `helper.log` for a "Mic opened" line per dictation; if there's none, run `python wispr_mute.py watch` and dictate to see whether the mic shows as open |
| Audio didn't come back | The helper stopped mid-dictation | Start it again (the **Start helper** link, or `install.py`), which restores on start, or run `python wispr_mute.py repair-audio --fix` |
| Other apps get quieter, not silent, when you dictate | Windows communications ducking, not this helper (`status` shows the setting) | Sound settings → More sound settings → Communications tab → **Do nothing** |
| Sound plays through a different device than expected | With no whitelisted app switched on, only the default output is muted | Switch on any whitelisted app, which makes it mute app by app on every device |
| A whitelisted app is still muted | It's switched off in the flyout, or you muted it yourself | Check its square is in colour, and its exe name with `status`. The helper only unmutes what it muted |
| An app's square shows a letter or a grey tile | Its icon is a plain shape, or the helper doesn't know where its exe is yet | It updates once the app runs. Deleting its file in `~/.claude/wispr-mute/icons/` makes it regenerate |
| Wispr Flow's icon is in the **^** overflow | The helper isn't running, or you dragged it there this session | Check `status` and `helper.log` for a "Pinned Wispr Flow's tray icon" line. Drag it back, or rerun `install.py` |
| The tray icon is missing | It's in the **^** overflow, or it isn't running | Check the overflow. Start it with the **Wispr Mute tray** Startup shortcut or rerun `install.py`. Errors go to `tray.log` |
| `FAILED: Wispr Flow isn't installed` | Wispr Flow isn't at `%LOCALAPPDATA%\WisprFlow` | Install Wispr Flow for your user from [wisprflow.ai](https://wisprflow.ai), then rerun |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.0.0: First public version.
