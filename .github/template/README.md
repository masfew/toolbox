<!--
Starting a new tool:
1. Copy this folder to a new folder named after the tool (lowercase, hyphens), inside the folder for its kind at the root of the repo: skills/, instructions/ (CLAUDE.md rules and output styles), extensions/ (mods, hooks and add-ons that another program runs) or apps/ (programs you start yourself; make the kind folder if it isn't there yet). A tool that is more than one kind goes where its main part belongs: a skill that comes with a hook goes in skills/, a hook with background helpers in extensions/.
2. Replace every <placeholder> and the guidance under each heading. Keep every heading.
3. Set TOOL_NAME, FILES, HOOKS and PROGRAMS in install.py, and delete config.example.json if the tool has no settings. Keep the install.py functions the tool uses as they are, or mark why one differs, as the top of install.py explains.
4. Add the tool's row to the root README's Tools section, in the table under the heading for its kind of tool (such as "Skills"; add a heading with its own table if none fits), starting with <a id="<tool-name>"></a> so that https://github.com/masfew/toolbox#<tool-name> links to the row. The name must not match a heading in the root README (such as "updating").
5. Delete this comment.
-->
# <Tool Name>

Version <0.1.0>. See the [changes](#changes) at the end.

## What It Does

Two sentences: what the tool does and who it's for. Then a screenshot, a GIF or a short before-and-after example, with nothing personal in it.

## Requirements

- Claude Code (<the desktop app, the terminal CLI, or both>)
- Python 3.9 or newer
- <Any other program, with the version it needs, and any account, for example a phone app>
- Tested on Windows 11. <macOS and Linux: untested.>

## Quick Start

The shortest path to a working install, from the root of the cloned repo (PowerShell or bash):

```bash
cd <kind>/<tool-name>
python install.py
```

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install <tool-name>."* With a clone already there, open Claude Code in it and say *"Install <tool-name>."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

<!-- Write both lists so a fresh Claude session can install the tool from them and Install below, with no other help. Claude does: every step a session can run and check. Programs outside the clone are asked about first, with the exact command. You do: only what needs the person (a secret typed into a hidden prompt, an account, a click in another app, a password for sudo or an admin prompt), each with where to do it. -->

**Claude does:**

1. Checks the [requirements](#requirements), and asks before installing anything missing, with the exact command from [Install](#install). On Windows, run `Get-Command python` (PowerShell) first: if it points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python, so tell the person and wait for a yes before running `python` at all.
2. <Tells you anything the install changes that you'd notice, before running it.>
3. Runs `python install.py` from `<kind>/<tool-name>`, and checks it ends with **Setup complete**.

**You do:**

1. <Each step only you can do, or "Nothing during the install.">
2. Start a new Claude Code session.

## Install

1. <Install anything from Requirements that's missing, and how.>
2. From the tool's folder, run `python install.py` (PowerShell or bash). It:
   - puts the tool at `~/.claude/tools/<tool-name>`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux), so a `git pull` updates the tool. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - <links which files under `~/.claude/tools/<tool-name>` to which places under `~/.claude`>
   - <adds which entries to `~/.claude/settings.json`, after backing it up>
   - <Windows, if the tool has background programs: adds which Startup shortcuts, which run them at sign-in through `~/.claude/tools/<tool-name>`, and starts them now. On a rerun it stops the running ones first.>
   - <if the tool has CLAUDE.md lines: shows the lines it would add to `~/.claude/CLAUDE.md`, between two marker lines, and asks first. `--instructions` or `--no-instructions` answers ahead of time; with no terminal to ask in, it leaves them out and says how to add them.>
   - <on Windows, when the Claude desktop app runs the install and the tool writes under AppData, it reruns itself outside the app's package, so its changes reach the real folders. It says so when it does.>
   - creates `~/.claude/<tool-name>.json` from `config.example.json` if you don't have one yet
   - saves what it installed to `~/.claude/tools/<tool-name>.install.json`
3. <Edit the config file, if the tool has one.>
4. Start a new Claude Code session.

The install is safe to rerun. It never adds an entry twice, and it leaves your other settings alone.

## Configuration

Settings are read from `~/.claude/<tool-name>.json`, which the install creates from `config.example.json`.

| Setting | What it does | Default | Example |
|---|---|---|---|
| `<name>` | <what it changes> | <default> | <example> |

## Usage

Real examples of using the tool and what to expect from each.

## How It Works

Which files it reads and changes, and what runs when. For example: which hook runs on which event, and what it does.

Everything the install adds points at `~/.claude/tools/<tool-name>`, never at the folder you installed from: the hook commands in `settings.json` and the links under `~/.claude`. Only `~/.claude/tools/<tool-name>` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/<tool-name>.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `<tool-name>-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell or bash):

```bash
git pull
cd <kind>/<tool-name>
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout <tool-name>-v<0.1.0>
cd <kind>/<tool-name>
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `<tool-name>` folder inside it. The install copies the tool to `~/.claude/tools/<tool-name>`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed (for example when a `git pull` reorganises the repo), what happens depends on how it was installed. In a git clone, `~/.claude/tools/<tool-name>` is a link to the folder, so the link is left pointing at a folder that's gone and the tool's hooks and skills stop working until you rerun `python install.py` from the new folder, which points the link there and takes out anything stale. An install made as a copy (an unzipped release, or `--copy`) keeps working as it is, and rerunning from the new folder switches it over.

## Uninstall

From the tool's folder (PowerShell or bash):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/<tool-name>` instead.

This removes everything the install added, including `~/.claude/tools/<tool-name>` and its install record, even if the install was made from a different folder. It leaves your config file, `~/.claude/<tool-name>.json`, in place. Delete it yourself if you don't need it.

<If the install changes `~/.claude/settings.json` or `~/.claude/CLAUDE.md`: `--remove` backs the file up before changing it, and the `settings.json.bak-<date>-<time>` and `CLAUDE.md.bak-<date>-<time>` backups it and the install made stay in place. Delete them yourself if you don't need them. Name only the files this tool changes.>

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| <the error or what you see> | <why it happens> | <what to do> |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- <0.1.0>: <First version.>
