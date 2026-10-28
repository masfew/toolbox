# Toolbox

A personal, unofficial collection of tools: add-ons for [Claude Code](https://claude.com/claude-code) (hooks, skills, output styles, mods and helper scripts) and other tools for working on a PC. None of it is made, endorsed or supported by Anthropic.

Each tool lives in its own folder, works on its own, and has a README that covers what it does, how to install it, how to configure it and how to remove it.

## Tools

The tools are grouped by kind, and each kind has its own folder in the repo: `skills/`, `instructions/`, `extensions/` and `apps/`. A folder is only there once it holds a tool.

### Skills

| Tool | What it does | Tested on |
|---|---|---|
| <a id="artifact-style"></a>[artifact-style](skills/artifact-style/) | Skill that gives every Artifact page Claude writes by hand (write-ups, handoffs, reports, runbooks, small tools) one shared look, soft greys, one blue accent, status colours and IBM Plex fonts in light and dark mode, instead of each session picking its own palette | Windows 11 (macOS and Linux untested) |
| <a id="better-plans"></a>[better-plans](skills/better-plans/) | Skill that publishes every plan Claude writes as an Artifact page from one fixed template (overview, step cards, statuses, future idea cards you accept or reject) and updates the same page in place | Windows 11 (macOS and Linux untested) |
| <a id="instruction-manager"></a>[instruction-manager](skills/instruction-manager/) | Skill that every session loads before it creates, changes or audits your skills and CLAUDE.md files: a house style, word budgets, duplicate and broken-link checks, trigger tests at a cost you choose before each run, audits, and a hook that catches edits made without it | Windows 11 (macOS and Linux untested) |

### Extensions

Extensions add to an app you already use, which runs them for you: Claude Code or another program. For Claude Code they're mods, plugins that change its own interface or behaviour and install with one command and no clone, as [Installing a Mod](#installing-a-mod) says, or hooks, programs it runs on its own events (such as a session finishing or asking a question) that their installer adds to your `~/.claude/settings.json`.

| Tool | What it does | Tested on |
|---|---|---|
| <a id="phone-bridge"></a>[phone-bridge](extensions/phone-bridge/) | Hooks that push to your phone through your own Telegram bot when a Claude Code session finishes, asks a question or waits on a permission prompt, with bot commands to turn pushes on for working sessions, snooze them and archive finished sessions, and an optional phone launcher that starts a new Claude desktop app session on your PC from a message | Windows 11 (macOS and Linux untested and unsupported) |
| <a id="usage-rings"></a>[usage-rings](extensions/usage-rings/) | Mod with ring gauges next to the prompt box for context, 5-hour and 7-day usage, blue, then orange from 70% and red from 90%: above the box in the desktop app, as text bars under it in the terminal | Windows 11 (macOS and Linux untested) |

### Instructions

Instructions are text every Claude Code session follows: rules their installer adds to your `~/.claude/CLAUDE.md`, or an output style that shapes how Claude writes its replies.

| Tool | What it does | Tested on |
|---|---|---|
| <a id="get-to-the-point"></a>[get-to-the-point](instructions/get-to-the-point/) | Output style that makes every reply quick to read: what matters first, plain words, no play-by-play, technical depth only when it helps, and numbered rules you can point a reply at ("point 13"). Built for running several sessions side by side | Windows 11 (macOS and Linux untested) |
| <a id="global-rules"></a>[global-rules](instructions/global-rules/) | Rules you can add one file at a time: sessions make implementation choices themselves and ask only about what you'd notice, what reaches outside the project, what would use a large share of your plan's limits or what could be unsafe, every subagent gets a model and effort matched to its work, and each next-step button does only what its label says | Windows 11 (macOS and Linux untested) |

### Apps

Apps are programs you start yourself, outside Claude Code. Claude Code can still install them for you, as [Installing with Claude Code](#installing-with-claude-code) says.

| Tool | What it does | Tested on |
|---|---|---|
| <a id="sketch"></a>[sketch](apps/sketch/) | Fast, simple paint app (a modern Microsoft Paint) with layers, editable shapes, arrows and text, screenshot mark-up, whiteboards, tabs and a screen capture key that works anywhere; a copy built from a clone updates itself after each `git pull` | Windows 11 (Windows only) |
| <a id="wispr-mute"></a>[wispr-mute](apps/wispr-mute/) | Tray helper for Wispr Flow that mutes your audio the moment you start dictating and unmutes it when you stop, with a whitelist of apps (such as Discord) that stay audible, and keeps Wispr Flow's tray icon pinned across its updates | Windows 11 (Windows only) |

## Linking to a Tool

To share a tool, link to its row in the Tools tables above: `https://github.com/masfew/toolbox#<tool>`, for example [`https://github.com/masfew/toolbox#get-to-the-point`](https://github.com/masfew/toolbox#get-to-the-point). To share a version you can download, link to the [releases page](https://github.com/masfew/toolbox/releases).

Prefer the row link to a link to the tool's folder. The row link and the release names use only the tool's name, so they keep working if a tool's folder ever moves.

## Installing with Claude Code

Claude Code can install any tool here for you. Open it in the folder you want the clone in and say, with the tool's name from the Tools tables:

> Clone https://github.com/masfew/toolbox and install get-to-the-point.

Claude clones the repo, finds the tool's row and its README, and installs it. Every tool's README has an **Install with Claude Code** section with two lists:

- **Claude does:** the steps Claude runs itself, such as running the installer and checking it worked. Before installing any program outside the clone (Python, a toolchain), it tells you the exact command and waits for your yes.
- **You do:** the steps only you can do, such as typing a token into the installer's hidden prompt, creating an account or clicking in another app. Claude reads them out one at a time and waits for you to finish each.

Claude never asks you for a token, password or key in the chat. A tool that needs one has its installer ask for it in your own terminal, so it never passes through the chat.

The same rules are in the repo's [`CLAUDE.md`](CLAUDE.md), which Claude Code reads when it works in the clone. To install a tool yourself instead, follow [Installing a Tool](#installing-a-tool).

## Installing a Tool

You need [Claude Code](https://claude.com/claude-code), [Git](https://git-scm.com/) and [Python](https://www.python.org/downloads/) 3.9 or newer. Some tools need more, and their README says so.

1. Clone the repo. This works the same in PowerShell and bash:

   ```bash
   git clone https://github.com/masfew/toolbox.git
   ```

2. Open the tool's folder and follow its README. Most tools install with one command, run from inside the tool's folder (PowerShell or bash):

   ```bash
   python install.py
   ```

   The install is safe to rerun. It backs up any file it changes, such as `~/.claude/settings.json`, and only adds its own entries.

3. To remove a tool, run the same script with `--remove` (PowerShell or bash):

   ```bash
   python install.py --remove
   ```

### Installing a Mod

The repo is also a Claude Code plugin marketplace named `toolbox`, listing the mods among the [Extensions](#extensions). A mod installs without a clone, with one command in a terminal (PowerShell or bash):

```bash
claude plugin install <mod> --marketplace masfew/toolbox
```

At the prompt of a Claude Code session in the terminal, `/plugin install <mod> --marketplace masfew/toolbox` does the same. Each mod's README also covers installing from a clone with `python install.py`, updating and removing it.

## Updating

Before you update, see what changed. Each tool's README ends with a Changes list, and each release on the [releases page](https://github.com/masfew/toolbox/releases) has that version's notes. When the first number of a version goes up, its notes say what you need to do.

Pull the latest version, then rerun the install of each tool you use, from inside the tool's folder (PowerShell or bash):

```bash
git pull
python install.py
```

### Staying on a Version

To keep a tool on a version you know works, check out that release's tag, then rerun the install from inside the tool's folder (PowerShell or bash):

```bash
git fetch --tags
git checkout example-tool-v1.2.0
python install.py
```

A tag holds the whole repo as it was at that release, so every other tool in the clone goes back to that point too. To return to the latest versions, run `git checkout main` and `git pull`, then rerun the installs. (`git pull` on its own doesn't work while a tag is checked out.)

To keep different tools on different versions, download a tool's zip from its release instead of checking out the tag. Unzip it and run `python install.py` from the tool's folder inside it. The install copies the tool to `~/.claude/tools/<tool>`, so the unzipped folder can be deleted afterwards. Mods are the exception: a mod's zip holds only its own folder, without the repo's marketplace file, so its `install.py` can't install from it. Install a mod with the one-line command in [Installing a Mod](#installing-a-mod), or from a clone, where checking out its tag keeps it on a version.

## Versions and Releases

Each tool has its own version number, since the tools change at different times. Versions follow [semantic versioning](https://semver.org/), `MAJOR.MINOR.PATCH`:

| Change | Example | When |
|---|---|---|
| Patch | 1.2.0 to 1.2.1 | Fixes. Nothing for you to do. |
| Minor | 1.2.1 to 1.3.0 | New features that work without any change on your side. |
| Major | 1.3.0 to 2.0.0 | Changes that need you to do something when you update, such as a new setting or a renamed command. The Changes entry says what. |

A tool's version is in the version line at the top of its README, and each version has an entry at the end, under Changes, written as `- 1.2.0: what changed`. If a tool is packaged as a Claude Code plugin, its `plugin.json` carries the same version.

Each release has a git tag named `<tool>-v<version>`, for example `example-tool-v1.2.0`, and a [GitHub release](https://github.com/masfew/toolbox/releases) with that version's Changes entry as its notes and a zip of the tool's folder.

### Making a Release

1. Update the tool's version line and add its Changes entry, in the same commit as the change or after it, and push that to `main`.
2. Check the release from the root of the repo (PowerShell or bash). It prints the notes the release will have, or says what's missing:

   ```bash
   python .github/scripts/release_notes.py example-tool-v1.2.0
   ```

3. Tag that commit and push the tag (PowerShell or bash):

   ```bash
   git tag example-tool-v1.2.0
   git push origin example-tool-v1.2.0
   ```

The release workflow then checks the tag against the README again, and makes the GitHub release with the notes and the zip. If it fails, its log says why. Delete the tag with `git push origin --delete example-tool-v1.2.0` and `git tag -d example-tool-v1.2.0`, fix the README, and tag again.

Tools listed in the release workflow's `BUMP_FOLDERS` (for now only Sketch) skip steps 2 and 3: a push to `main` that raises the tool's version line is checked and tagged by the workflow itself, which then makes the release in the same run. A push that raises the version line without a Changes entry fails the run and makes no tag. Tagging by hand still works for them too. To rerun a failed release, use **Re-run failed jobs**, which keeps the tag; **Re-run all jobs** finds the tag already there and releases nothing, so delete the tag first.

## Repo Layout

| Path | What it holds |
|---|---|
| `<kind>/<tool>/` | One folder per tool, inside the folder for its kind (`skills/`, `instructions/`, `extensions/` or `apps/`; output styles go in `instructions/`, and mods and hooks in `extensions/`), with its own README, `install.py` and `config.example.json` where it needs one. A tool that is more than one kind sits where its main part belongs: a skill that comes with a hook is in `skills/`. Link to a tool as [Linking to a Tool](#linking-to-a-tool) says |
| `CLAUDE.md` | The rules Claude Code follows when it installs, updates or removes a tool from the clone (see [Installing with Claude Code](#installing-with-claude-code)) |
| `.github/template/` | The starting point for a new tool |
| `.claude-plugin/marketplace.json` | Makes the repo the `toolbox` plugin marketplace, listing each mod and its folder in `extensions/`. A mod's folder moving means changing its `source` here |
| `.github/workflows/secret-scan.yml` | Scans every push for secrets with [gitleaks](https://github.com/gitleaks/gitleaks), and checks that no two tool folders share a name |
| `.github/workflows/release.yml` | Turns each pushed `<tool>-v<version>` tag into a GitHub release |
| `.github/workflows/sketch.yml` | Builds Sketch, runs its unit tests and checks its installer's size and start-up time whenever `apps/sketch/` changes |
| `.github/scripts/release_notes.py` | Finds a release tag's tool folder at any depth, checks the tag against the tool's README, and writes the release's notes and zip. `--check-names` checks that tool folder names are unique |
| `.github/scripts/pre_push_check.py` | Checks a push for secrets, personal identifiers, non-noreply commit emails, clashing tool folder names and tool installers that drift from `.github/template/install.py` (see [Before You Push](#before-you-push)) |
| `.github/scripts/public-repo-identifiers.example.txt` | A starting point for the identifier list the check reads |
| `.github/hooks/pre-push` | The git hook that runs the check before every push, once turned on |
| `.github/hooks/pre-commit` | The git hook that runs the check on the working tree before every commit, once turned on |
| `LICENSE` | The MIT license that covers the whole repo |
| `.gitignore` | Keeps personal config, logs, caches and the install scripts' `.bak` backups out of the repo |
| `.gitattributes` | Keeps the git hooks' line endings as LF, which `sh` needs, even in a Windows checkout |

## Personal Settings

No tool stores your personal values in this repo. A tool that needs settings (a token, a topic, a path) reads them from a config file in `~/.claude/`, and ships a `config.example.json` with placeholder values to copy from.

## Contributing

Issues and pull requests are turned off, since this is a personal toolbox. You're welcome to fork it and change anything under the license.

### Before You Push

If you push from your own clone or fork, you can turn on the checks this repo uses. Before every `git commit`, the pre-commit hook checks the working tree and stops the commit if it finds a problem, so nothing has to be rewritten later. Before every `git push`, the pre-push hook stops the push if the commits being pushed hold a secret (found by [gitleaks](https://github.com/gitleaks/gitleaks)), one of your own identifiers, or an author or committer email that isn't a [GitHub noreply address](https://docs.github.com/en/account-and-profile/setting-up-and-managing-your-personal-account-on-github/managing-email-preferences/setting-your-commit-email-address). It's optional.

1. Install gitleaks, for example with `winget install Gitleaks.Gitleaks` on Windows or `brew install gitleaks` on macOS.
2. Copy `.github/scripts/public-repo-identifiers.example.txt` to `~/.claude/public-repo-identifiers.txt` and replace its examples with your own: your username, real name, email addresses, private project names and anything else that mustn't be published. Keep it outside the repo.
3. Turn on both hooks once in your clone, from its root (PowerShell or bash):

   ```bash
   git config core.hooksPath .github/hooks
   ```

To run the same check by hand on the working tree, from the root of the repo (PowerShell or bash):

```bash
python .github/scripts/pre_push_check.py
```

Both hooks and the hand-run check also compare each tool's `install.py` with `.github/template/install.py`, function by function, and stop on a function that differs, so a fix made in one copy reaches the others. A tool that needs a function to work differently says why with a `# differs from the template: <reason>` line right under its `def`. The top of `.github/template/install.py` has the details.

The check stops the commit or push, rather than letting it through, if gitleaks or the identifier list is missing. It only finds the identifiers on your list, so it doesn't replace reading your own diff before you push.

## License

[MIT](LICENSE)
