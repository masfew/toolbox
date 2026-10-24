# Usage Rings

Version 2.0.0. See the [changes](#changes) at the end.

## What It Does

A Claude Code mod (a plugin with a hooks module) that keeps three gauges next to the prompt box, so you can see at a glance how close you are to each limit:

- **Context**: how full the session's context is, with the token count (`84k / 500k`). It's measured against your auto-compact window when you've set one smaller than the model's, as the app's own context menu does, and otherwise against the model's full window.
- **5-hour**: your 5-hour usage limit, with the time left until it resets.
- **7-day**: your weekly usage limit, with the time until it resets.

Each gauge is blue below 70%, orange from 70% and red from 90%, the same scheme as the app's own context ring. In the desktop app they're rings above the prompt box (the numbers here are made up):

![Three ring gauges: Context 17% in blue, 5-hour 75% in orange, 7-day 93% in red](docs/preview.svg)

In the terminal they're coloured text bars in the hint line under the prompt box:

```text
▰▱▱▱▱ Context 17% · 84k / 500k  ▰▰▰▰▱ 5-hour 75% · 2h 10m left  ▰▰▰▰▰ 7-day 93% · resets in 3d 0h
```

## Requirements

- Claude Code 2.1.275 or newer, with its `claude` command available in a terminal. The mod shows in both the desktop app (Code tab) and the terminal CLI once it's installed.
- A Claude subscription for the 5-hour and 7-day gauges. With API key billing there are no usage limits to show, so only the context gauge has a reading.
- Only for installing from a clone: [Git](https://git-scm.com/) and Python 3.9 or newer.
- Tested on Windows 11 with Claude Code 2.1.303, in the desktop app. The terminal bars are covered by the mod's tests. macOS and Linux: untested.

## Quick Start

In a terminal (PowerShell or bash):

```bash
claude plugin install usage-rings --marketplace masfew/toolbox
```

Or at the prompt of a Claude Code session in the terminal:

```text
/plugin install usage-rings --marketplace masfew/toolbox
```

New sessions show the rings. In a session that's already open, run `/reload-plugins`.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install usage-rings."* With a clone already there, open Claude Code in it and say *"Install usage-rings."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks `claude --version` is 2.1.275 or newer. If it's older, it stops and tells you to update Claude Code.
2. Runs `python install.py` from `mods/usage-rings` (the [From a clone](#from-a-clone-of-the-repo) install), and checks it ends with **Setup complete**. Asked to install it without a clone, it runs the [Quick Start](#quick-start) command instead.

**You do:**

1. Nothing during the install.
2. Start a new Claude Code session, or run `/reload-plugins` in an open one. The rings show next to the prompt box.

## Install

There are two ways to install it. Both install the mod for your user, so it loads in every project, in the desktop app and in the terminal.

### From GitHub (no clone)

Run the [Quick Start](#quick-start) command. It adds this repo as a plugin marketplace named `toolbox` (a list of plugins Claude Code can install from), then installs `usage-rings@toolbox` from it. In the `/plugin` form, Claude Code asks you to confirm adding the marketplace and to pick a scope: choose user.

### From a clone of the repo

Use this to install the exact version you have checked out, or to change the mod yourself. (To try a clone before it's on GitHub, the Quick Start command also takes the clone's path after `--marketplace`.)

1. Clone the repo, if you haven't (PowerShell or bash):

   ```bash
   git clone https://github.com/masfew/toolbox.git
   ```

2. Run the installer from the `usage-rings` folder (PowerShell, or bash with `python3` on macOS and Linux):

   ```bash
   cd toolbox/mods/usage-rings
   python install.py
   ```

   It's safe to rerun, and it:
   - adds the clone as the `toolbox` marketplace, unless you already have a marketplace of that name (for example from the GitHub install, which it then uses as it is). If the clone has moved since an earlier install, it replaces the old entry.
   - refreshes the marketplace, then installs `usage-rings@toolbox` at the user scope, or updates it if it's already installed.

   It ends with **Setup complete**, or with **FAILED:** and what to do. Fix that and rerun.

3. Start a new Claude Code session, or run `/reload-plugins` in an open one.

A release zip from the [releases page](https://github.com/masfew/toolbox/releases) holds only this folder, without the repo's marketplace file, so `install.py` can't install from it. Use one of the two ways above.

## Configuration

There's no config file. The thresholds and colours are constants at the top of [`hooks/register.tsx`](hooks/register.tsx):

| Setting | What it does | Default | Example |
|---|---|---|---|
| `WARN` | The percentage where a gauge turns orange | `70` | `80` |
| `CRITICAL` | The percentage where a gauge turns red | `90` | `95` |
| `BLUE`, `ORANGE`, `RED` | The gauge colours | `#4A8FE7`, `#E8873A`, `#E5484D` | `#2EA043` |

To change them, edit the file in a clone, bump `version` in [`.claude-plugin/plugin.json`](.claude-plugin/plugin.json), and rerun `python install.py`. Claude Code installs a copy of the mod, and it only picks up a change when the version goes up.

To turn the mod off for a while without removing it, run `claude plugin disable usage-rings@toolbox`, and `claude plugin enable usage-rings@toolbox` to turn it back on.

## Usage

There's nothing to run. Once it's installed, every new session shows the gauges:

- **Desktop app:** ring chips in the band directly above the prompt box. While Claude asks you a question, the question card replaces the prompt box, so the rings sit above the card instead. When the app shows a survey in the band, the rings step aside until it's gone.
- **Terminal:** text bars in the hint line under the prompt box, followed by the usual hint text.

The 5-hour and 7-day gauges say "no reading yet" in a new session until Claude's first reply. Each gauge's colour tells you how close you are: blue is fine, orange is getting close, red is nearly out.

## How It Works

The mod is a hooks module, [`hooks/register.tsx`](hooks/register.tsx), that Claude Code loads in every session:

- When a session starts, and again after each turn (the `session.measure` event), it reads the session's usage from Claude Code and keeps it in the session's state.
- It draws the gauges by answering `ui.render` for three spots: the band above the prompt box (`AbovePrompt`) and the question card (`AskUserQuestion`) in the desktop app, and the hint line (`PromptHint`) in the terminal.
- A one-minute timer keeps the reset countdowns current between replies.

The 5-hour and 7-day figures come from the last response Claude received, so they don't move while a session is idle. The context figure is estimated locally and sends no requests. The mod reads nothing else and sends nothing anywhere.

There are some places it can't draw: a new chat in the desktop app before its first message (no session is running yet, so no mod is loaded), and permission prompts (the app gives mods no spot there). The rings come back when the session starts or the prompt is answered.

What the install changes, all through Claude Code's own plugin commands:

| Path | What it is |
|---|---|
| `~/.claude/settings.json` | The `toolbox` marketplace under `extraKnownMarketplaces`, and `"usage-rings@toolbox": true` under `enabledPlugins` |
| `~/.claude/plugins/` | Claude Code's records of marketplaces and installed plugins, and its copy of the mod under `cache/toolbox/usage-rings/<version>` |

## Updating

Read the [changes](#changes) first for anything that needs you to do something.

If you installed from GitHub (PowerShell or bash):

```bash
claude plugin marketplace update toolbox
claude plugin update usage-rings@toolbox
```

If you installed from a clone, from the root of the clone (PowerShell, or bash with `python3` on macOS and Linux):

```bash
git pull
cd mods/usage-rings
python install.py
```

Then start a new session, or run `/reload-plugins` in an open one.

To stay on a version, check out its tag in a clone, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout usage-rings-v1.0.0
cd mods/usage-rings
python install.py
```

Releases up to usage-rings-v2.0.0 have the tool's folder at the root of the repo, so after checking out one of those, it's `cd usage-rings` instead.

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install.

## Uninstall

If you installed from a clone, from the `usage-rings` folder (PowerShell, or bash with `python3` on macOS and Linux):

```bash
python install.py --remove
```

This uninstalls the mod. It also removes the `toolbox` marketplace if it points at this clone and no other plugin from it is installed.

If you installed from GitHub (PowerShell or bash):

```bash
claude plugin uninstall usage-rings@toolbox
claude plugin marketplace remove toolbox
```

Skip the second command if you use other plugins from the `toolbox` marketplace. Sessions that are already open keep the rings until they restart.

Whichever way you installed, `claude plugin uninstall usage-rings@toolbox` removes the mod itself.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| No rings in an open session after installing | Mods load when a session starts | Start a new session, or run `/reload-plugins` |
| No rings in a new desktop chat | No session runs until the first message | Send a message; the rings appear with the session |
| 5-hour and 7-day say "no reading yet" | They come from Claude's last response, and this session has none yet | They fill in after Claude's first reply |
| 5-hour and 7-day never get a reading | You're billed with an API key, which has no usage limits | Nothing to do: only the context gauge applies |
| A change to `hooks/register.tsx` doesn't show up | Claude Code runs its own copy, and only updates it when the version goes up | Bump `version` in `.claude-plugin/plugin.json`, rerun `python install.py`, then `/reload-plugins` |
| **FAILED: can't find the claude command** | Claude Code's terminal command isn't installed or isn't on PATH | Install Claude Code from [claude.com/claude-code](https://claude.com/claude-code), open a new terminal, then rerun |
| **FAILED: no .claude-plugin/marketplace.json in any folder above this one** | `install.py` was run from a release zip or a copied folder, not a clone | Use the [Quick Start](#quick-start) command, or run it from a clone |
| `using the toolbox marketplace you already have, from ...` | You'd already added the marketplace another way, such as from GitHub | Nothing to do: it installs from that one. To use the clone instead, run `claude plugin marketplace remove toolbox` and rerun |

## Developing

From the `usage-rings` folder of a clone (PowerShell or bash):

```bash
claude plugin validate .
claude plugin test .
```

[`tests/rings.test.tsx`](tests/rings.test.tsx) checks the desktop rings' text and colours and the terminal bars. Type-checking needs the engine's types, which Claude Code writes into `.claude-plugin/types/` (git-ignored) once it has loaded the mod from this folder, for example with `claude --plugin-dir .`; then run `tsc -p .`.

Some things about the mod API found while building it:

- `$.ui.toast` from a mod didn't show in the desktop app.
- In a test, stand in for `$.clock.every` with a hook that never resolves (`on('clock.every', () => new Promise<never>(() => {}))`). An answer holding a function can't be cloned.

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 2.0.0: The repo and its plugin marketplace were renamed from `ai-toolkit` to `toolbox`, so the mod is now `usage-rings@toolbox`. If you installed 1.0.0, remove it first with `claude plugin uninstall usage-rings` and `claude plugin marketplace remove ai-toolkit`, then install again with the [Quick Start](#quick-start) command or `python install.py` from a new clone.
- 1.0.0: First public version, installed from the repo's `ai-toolkit` plugin marketplace.
