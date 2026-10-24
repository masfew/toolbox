# artifact-style

Version 1.0.0. See the [changes](#changes) at the end.

## What It Does

A Claude Code skill that gives every Artifact page Claude writes by hand the same look: write-ups, handoff pages, reports, audits, explainers, comparisons, runbooks and small tools. Without it, each session picks its own colours and fonts for the subject, so pages come out green, warm or purple at random and never look like one set.

The look is one stylesheet, `skill/house.css`, which Claude publishes beside each page: soft greys, one blue accent for links and the main action, green, yellow, red and orange only for statuses, and IBM Plex Sans and Mono, in light and dark mode. It matches the plan pages of the better-plans skill, so plans and other pages look alike if you use both, and it works on its own without better-plans.

Each page starts from `skill/template.html`, which gives it this shape:

```html
<main class="page">
  <header class="page-header">
    <div class="eyebrow">project · topic · 1 Jan 2026</div>
    <h1>Project Topic</h1>
    <p class="lede">The outcome first: what the reader needs to know.</p>
  </header>
  <section class="block">
    <h2>Section heading</h2>
    <div class="table-wrap"><table class="table">…</table></div>
    <div class="note" data-tone="blocked"><span class="note-label">Not tested yet</span><p>An aside.</p></div>
  </section>
</main>
```

## Requirements

- Claude Code with Artifacts (the desktop app or claude.ai/code), signed in to an account that can publish Artifact pages
- Python 3.9 or newer, for the installer
- Tested on Windows 11. macOS and Linux: untested.

## Quick Start

From the root of the cloned repo (PowerShell, or bash with `python3` on macOS and Linux):

```bash
cd skills/artifact-style
python install.py
```

It asks whether to add two lines to `~/.claude/CLAUDE.md` (say yes, see [Install](#install)) and ends with **Setup complete**. Start a new Claude Code session.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install artifact-style."* With a clone already there, open Claude Code in it and say *"Install artifact-style."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks Python 3.9 or newer is installed, and asks before installing it if it's missing, with the command from [Install](#install) step 1.
2. Shows you the two lines the install adds to `~/.claude/CLAUDE.md` (in [Install](#install) step 2), which make every session load the skill before writing an Artifact page, and asks whether you want them.
3. Runs `python install.py --instructions` from `skills/artifact-style` if you said yes, or `python install.py --no-instructions` if you said no (`python3` on macOS and Linux), and checks it ends with **Setup complete** and that `~/.claude/skills/artifact-style/SKILL.md` now exists.

**You do:**

1. Start a new Claude Code session, so it loads the skill.

## Install

1. **Python 3.9 or newer.** Check with `python --version` (on macOS and Linux, `python3 --version`). If it's missing, on Windows run `winget install Python.Python.3.13` and open a new terminal; on macOS, `brew install python`.
2. From this folder, run `python install.py` (PowerShell or bash). It:
   - puts the tool at `~/.claude/tools/artifact-style`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux), so a `git pull` updates the tool. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - links `~/.claude/skills/artifact-style` to the `skill` folder in `~/.claude/tools/artifact-style`
   - shows these lines and asks whether to add them to `~/.claude/CLAUDE.md`, between two marker lines:

     ```markdown
     - Before writing any HTML Artifact page by hand that isn't a plan made with better-plans,
       load the artifact-style skill along with artifact-design, and follow it for every colour and font.
     ```

     They make the skill apply every time, rather than only when its description happens to match what you asked. `--instructions` or `--no-instructions` answers ahead of time. With no terminal to ask in (as when Claude Code runs the install without either), it leaves them out and says how to add them.
   - saves what it installed to `~/.claude/tools/artifact-style.install.json`
3. Start a new Claude Code session.

The install is safe to rerun. It never adds an entry twice, and it leaves the rest of `CLAUDE.md` alone, backing it up before any change.

## Configuration

There are no settings. To change the look itself, see [Changing the Look](#changing-the-look).

## Usage

Ask for any page as you normally would. The skill loads on its own and Claude builds the page in the house look:

- *"Write up what we found about the flaky login test as an artifact page."* A page with the outcome in the header, a table of what was tried with status pills, and a note for what isn't confirmed.
- *"Make a runbook page for the monthly server patching steps and publish it."* Numbered sections, commands in code blocks, warnings as red-edged notes.
- *"Build a small html tool page where I can paste JSON and see it as a table."* The tool's controls and table use the same greys, blue main button and fonts.

It doesn't apply to plans made with better-plans (which have the same look built in), Artifact types that bring their own look (Slides, Docs, Dashboard, Design), or game UI and promo art. Content whose look is the point, such as a logo concept or a proposed colour palette, keeps its own colours inside a card, while the page around it stays in the house look.

## How It Works

- `skill/SKILL.md` tells Claude to copy `house.css` and `template.html` into its scratchpad, write the page with the building blocks it lists (header, sections, tables, status pills, notes, cards, diagrams), and publish `house.css` beside the page.
- `skill/house.css` holds every colour as a token (`--bg`, `--fg`, `--accent`, `--st-done-fg` and so on) with light and dark values. Pages may add a little CSS of their own, but only with these tokens, so dark mode keeps working and nothing drifts.
- `skill/evals/triggers.json` holds 20 test prompts, 10 that should load the skill and 10 near-misses that shouldn't, for checking the description after a change.

Everything the install adds points at `~/.claude/tools/artifact-style`, never at the folder you installed from: the skill link under `~/.claude/skills`. Only `~/.claude/tools/artifact-style` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/artifact-style.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Changing the Look

- Colours, fonts and building blocks: `skill/house.css`. The blocks and rules sessions follow: `skill/SKILL.md`. The starting page: `skill/template.html`.
- If you use better-plans too, `house.css` and its `plan.css` share their colour and font tokens. Change both together, then run this from this folder (PowerShell or bash):

  ```bash
  python -I tests/check_sync.py
  ```

  It finds `plan.css` in the same clone or in an installed better-plans, or takes its path as an argument, and prints **in sync** or lists every token that differs.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `artifact-style-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell or bash):

```bash
git pull
cd skills/artifact-style
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout artifact-style-v1.0.0
cd skills/artifact-style
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `artifact-style` folder inside it. The install copies the tool to `~/.claude/tools/artifact-style`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed (for example when the repo is reorganised), the install keeps working as it is. Rerunning `python install.py` from the new folder points `~/.claude/tools/artifact-style` there and takes out anything stale.

## Uninstall

From the tool's folder (PowerShell or bash):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/artifact-style` instead.

This removes everything the install added: the skill link, the lines in `~/.claude/CLAUDE.md`, `~/.claude/tools/artifact-style` and its install record, even if the install was made from a different folder.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Pages still come out in their own colours | The session started before the install, or the `CLAUDE.md` lines were left out, so the skill only loads when its description matches | Start a new session. Rerun `python install.py --instructions` to add the lines |
| Claude doesn't list the `artifact-style` skill | Claude Code reads skills when a session starts | Start a new session, or restart Claude Code |
| The page shows unstyled | `house.css` wasn't published beside the page | Ask Claude to republish the page with `house.css` in its files |
| `check_sync.py` says it couldn't find `plan.css` | better-plans isn't installed or cloned next to this tool | Pass the path: `python -I tests/check_sync.py <path to plan.css>`. Without better-plans there's nothing to keep in sync |
| `FAILED: ~/.claude/tools/artifact-style exists but isn't this tool` | Something else is in that folder | Move it elsewhere, then rerun |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.0.0: First public version.
