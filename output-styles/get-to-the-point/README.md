# Get to the Point

Version 1.0.1. See the [changes](#changes) at the end.

## What It Does

A Claude Code output style that makes every reply quick to read: what matters first, plain words, no play-by-play of what Claude opened and tried, and technical depth only when it helps. It's built for running several sessions side by side and reading their replies cold, between other tasks or as phone notifications.

The guidelines are in [`get-to-the-point.md`](get-to-the-point.md). They're a guide, not a template: Claude still chooses the wording and structure of each reply and decides what's worth including. They cover only the replies you read, not briefs for other sessions, commit messages, docs or pages, and they give way to any instruction that requires specific content in a reply.

Here's the made-up example from the style itself. Before:

> Great question! I took a deep dive into the authentication flow. First, I examined `auth/session.ts`, where I noticed that the token refresh logic leverages a setTimeout-based approach. After further investigation, I discovered that there is a potential race condition when multiple tabs are open, which could potentially cause issues. I've implemented a fix that utilizes a BroadcastChannel to coordinate refreshes across tabs. Additionally, I updated `auth/hooks.ts`, `auth/types.ts`, `lib/storage.ts`, and `tests/auth.test.ts`. It's also worth noting that Safari versions prior to 15.4 don't support BroadcastChannel. Let me know if you'd like me to add a polyfill or explore alternative approaches!

After:

> Fixed the random logouts for users with several tabs open. Each tab used to refresh the login on its own and they overwrote each other. Now one tab refreshes and tells the rest. The auth tests and a two-tab browser test both pass. The fix is in auth/session.ts.
>
> One gap: Safari older than 15.4 can't pass messages between tabs, so those users keep the old bug.

In the desktop app, the Safari gap becomes a question in the app's next-step box, with buttons to answer it.

> **Setting this up?** Open Claude Code and say: *"Set up the tool in `<path to this folder>`. Follow its README."* Claude: follow [Install](#install) from top to bottom (skip step 1 if the folder is already there), then report what happened.

## Requirements

- Claude Code: the desktop app or the terminal CLI. In the desktop app, Claude asks you to decide things through the app's question cards and next-step box. In the CLI, it asks numbered questions instead, so you can answer "1 yes, 2 B".
- Python 3.9 or newer, to run the install.
- Tested on Windows 11 with Python 3.14. macOS and Linux: untested.

## Quick Start

From the root of the cloned repo (PowerShell, or bash with `python3` on macOS and Linux):

```bash
cd output-styles/get-to-the-point
python install.py
```

It ends with **Setup complete**. New Claude Code sessions use the style from then on. On Windows without Developer Mode (the default), it also says the system didn't allow a link: the style is then a copy, so rerun `python install.py` after each update.

## Install

**This changes the default output style for every new Claude Code session**, in every project, until you remove it or pick another style. Sessions that are already open keep their style.

1. **Get the folder.** Either clone the repo (`git clone https://github.com/masfew/toolbox.git`), or download `get-to-the-point-v<version>.zip` from the [releases page](https://github.com/masfew/toolbox/releases) and unzip it.

2. **Python 3.9 or newer.** Check with `python --version` (on macOS and Linux, `python3 --version`; on Windows `py --version` also works). If it's missing:
   - Windows: `winget install Python.Python.3.13`, then open a new terminal so `python` is on PATH.
   - macOS: `brew install python` (install [Homebrew](https://brew.sh) first if needed).
   - Linux: your distro's package manager, for example `sudo apt install python3`.

3. **Run the installer from the `get-to-the-point` folder** (PowerShell, or bash with `python3` on macOS and Linux):

   ```bash
   python install.py
   ```

   It's safe to rerun, and it:
   - puts the tool at `~/.claude/tools/get-to-the-point`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux). From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - installs the style at `~/.claude/output-styles/get-to-the-point.md`, where Claude Code finds personal output styles. It's a link to `get-to-the-point.md` in `~/.claude/tools/get-to-the-point` where the system allows links to single files (macOS, Linux, and Windows with Developer Mode on). Otherwise it's a copy, and the installer says so: rerun it after each update to refresh the copy. If a different file is already at that path, it's backed up first, next to it.
   - sets `"outputStyle": "Get to the Point"` in `~/.claude/settings.json`, which makes the style the default for new sessions in the desktop app and the terminal CLI. If the file exists, it's backed up first (to `settings.json.bak-<date>-<time>` in the same folder), and your other settings are left alone. If it doesn't exist yet, it's created with only that setting, and there's nothing to back up.
   - saves what it installed, and the output style it replaced, to `~/.claude/tools/get-to-the-point.install.json`.

   It ends with **Setup complete**, or with **FAILED:** and what to do. Fix that and rerun.

4. **Start a new Claude Code session.** It uses the style. In the desktop app, Get to the Point is also in the list of output styles in the app's settings.

## Configuration

There's no config file. The one setting is which output style new sessions use:

| Setting | What it does | Default | Example |
|---|---|---|---|
| `outputStyle` in `~/.claude/settings.json` | The output style new sessions use. The install sets it | `"Get to the Point"` after the install | `"outputStyle": "Explanatory"` to switch back to a built-in style |

To use another style for a while without removing this one, pick it in the desktop app's settings, or change `outputStyle` in `~/.claude/settings.json`. A project's own `.claude/settings.json` or `.claude/settings.local.json` can set a different `outputStyle`, and that wins inside that project.

## Usage

Once it's installed, there's nothing to run: every new session follows the style. Some ways to steer it:

- **Correct a reply by rule number.** The rules in `get-to-the-point.md` have fixed numbers, so "point 13" means the reply had a sentence with no fact in it, and "point 25" means it used an em dash. That's quicker than describing what went wrong.
- **Ask for depth for one reply.** Say "details", "explain", "show the diff" or "walk me through it", and that reply can be as long as it needs. The next one is short again.
- **Change a rule that keeps failing.** Tighten its wording in `get-to-the-point.md`. Keep the numbers stable: a retired rule leaves its number empty, and a new rule takes the next unused number. If the installer made a copy rather than a link (it says so), rerun `python install.py` afterwards.

## How It Works

An output style is a Markdown file that Claude Code adds to the instructions of every session that uses it. It's sent with every message, and it still applies after a long conversation is compacted. A skill, by contrast, loads only when Claude decides it's relevant. Your `CLAUDE.md` files stay loaded alongside the style.

`get-to-the-point.md` sets `keep-coding-instructions: true` in its front matter. Without it, a custom output style drops Claude Code's built-in software engineering instructions. Output styles don't apply to subagents, so their prompts and reports keep their full detail.

What the install changes:

| Path | What it is |
|---|---|
| `~/.claude/tools/get-to-the-point` | A link to the folder you installed from, or a copy of it |
| `~/.claude/output-styles/get-to-the-point.md` | A link to `get-to-the-point.md` in `~/.claude/tools/get-to-the-point`, or a copy of it |
| `~/.claude/settings.json` | `"outputStyle": "Get to the Point"` makes it the default |
| `~/.claude/tools/get-to-the-point.install.json` | The install record: what the install added, and the `outputStyle` it replaced |

Everything the install adds points at `~/.claude/tools/get-to-the-point`, never at the folder you installed from. Only `~/.claude/tools/get-to-the-point` itself points at that folder (or holds a copy of it). A rerun reads the install record first, and `--remove` reads it to undo everything.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `get-to-the-point-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell, or bash with `python3` on macOS and Linux):

```bash
git pull
cd output-styles/get-to-the-point
python install.py
```

Where the style is a link, `git pull` alone updates it, and the rerun just checks everything. Where it's a copy (Windows without Developer Mode), the rerun is what refreshes it.

To stay on a version, check out its tag instead, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout get-to-the-point-v1.0.0
cd output-styles/get-to-the-point
python install.py
```

Releases up to get-to-the-point-v1.0.1 have the tool's folder at the root of the repo, so after checking out one of those, it's `cd get-to-the-point` instead.

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. If you installed from a release zip instead, unzip the new release and run `python install.py` from its `get-to-the-point` folder: it replaces the earlier copy.

If this folder moves or is renamed (for example when the repo is reorganised), the style keeps working where it's a copy. Rerun `python install.py` from the new folder: it points `~/.claude/tools/get-to-the-point` there and leaves nothing behind from the old folder.

## Uninstall

From the `get-to-the-point` folder (PowerShell, or bash with `python3` on macOS and Linux):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/get-to-the-point` instead.

This removes the style from `~/.claude/output-styles`, and `~/.claude/tools/get-to-the-point` with its install record, even if you installed from a different folder. If `outputStyle` in `~/.claude/settings.json` still says `"Get to the Point"`, it goes back to the style you had before the install, or is taken out so new sessions use Claude Code's default style. If you've switched to another style since, that setting is left alone. `settings.json` is backed up before it's changed, and deleted only if the install created it and nothing else is in it.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| New sessions don't use the style | The session was already open, or a project's `.claude/settings.json` or `.claude/settings.local.json` sets another `outputStyle` | Start a new session. Inside that project, change or remove its `outputStyle` |
| A change to `get-to-the-point.md`, or a `git pull`, doesn't show up | The style is a copy, not a link (Windows without Developer Mode) | Rerun `python install.py`. Turning on Windows Developer Mode and rerunning makes it a link |
| **FAILED: ... settings.json isn't valid JSON** | `~/.claude/settings.json` has a syntax error | Fix the file (the message says where), then rerun. Nothing was changed |
| `... exists but isn't this tool` | Something else is already at `~/.claude/tools/get-to-the-point` | Move it elsewhere, then rerun |
| `couldn't delete ~/.claude/tools/get-to-the-point` after `--remove` | A terminal or another program was open in that folder, so it was emptied but not deleted | Nothing else is left behind. Close it; the next `python install.py` or `--remove` deletes the empty folder |
| **FAILED: this is the installed copy** | `install.py` was run from `~/.claude/tools/get-to-the-point` | Run it from the folder you cloned or unzipped. From the installed copy, only `--remove` works |
| `left outputStyle as "..."` after `--remove` | You'd switched to another style since the install | Nothing to do: your choice is kept |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.0.1: A `--remove` run from the installed copy, in a terminal open in that folder, could leave `~/.claude/tools/get-to-the-point` behind empty on Windows, and the next install then stopped with "exists but isn't this tool". Installs and `--remove` now delete that empty folder.
- 1.0.0: First public version. Installs through `~/.claude/tools/get-to-the-point` with an install record, adds `--copy` and `--link`, and `--remove` puts back the output style you had before.
