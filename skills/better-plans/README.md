# better-plans

Version 1.5.0. See the [changes](#changes) at the end.

## What It Does

A Claude Code skill that makes every plan Claude writes look and read the same. Each plan (implementation, feature, project, game design or research plans, roadmaps, and plan-mode plans once approved) is published as an Artifact page built from one fixed template, and later updates change that same page, so a plan keeps one link for its whole life.

Every plan page has the same parts:

- a header with the version and dates, and a one-paragraph summary
- a plan overview table of phases, steps and statuses, linking to each step's details
- any extra sections the plan needs (goals, architecture, risks, diagrams and so on)
- the build outline: collapsible phase and step cards with What / How / Why details
- future idea cards with Accept (✓), Reject (✕) and Edit (pencil) buttons, and drag handles to reorder planned features, whose choices and edits the page saves for Claude to read back

For long work inside one session, the skill also keeps a **light plan**: a short Markdown file that is the session's plan and saved state, which a hook pastes back in after `/clear` (see [Light Plans](#light-plans)).

## Requirements

- Claude Code with Artifacts (the desktop app or claude.ai/code), signed in to an account that can publish Artifact pages with a page database. Plan pages declare the `db`, `user` and `artifact` capabilities; an account without them can't publish a plan.
- Python 3.9 or newer, for the installer and the skill's scripts
- Light plans need the Claude desktop app, since they live in its session notes folder. Elsewhere the skill makes full plan pages only, and the hook does nothing.
- Optional: [artifact-style](https://github.com/masfew/toolbox#artifact-style), which gives every other Artifact page the same look as plan pages. The install offers it.
- Optional, for changing the skill: Node.js, which two of the tests use
- Tested on Windows 11. macOS and Linux: untested.

## Quick Start

From the root of the cloned repo (PowerShell, or bash with `python3` on macOS and Linux):

```bash
cd skills/better-plans
python install.py
```

It asks whether to add a few lines to `~/.claude/CLAUDE.md` (say yes, see [Install](#install)), then whether to install artifact-style too, and ends with **Setup complete**. Start a new Claude Code session.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install better-plans."* With a clone already there, open Claude Code in it and say *"Install better-plans."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks Python 3.9 or newer is installed, and asks before installing it if it's missing, with the command from [Install](#install) step 1. On Windows, run `Get-Command python` (PowerShell) first: if it points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python, so tell the person and wait for a yes before running `python` at all.
2. Asks you two questions with its question tool, before running anything:
   - whether to add the lines in [Install](#install) step 2 to `~/.claude/CLAUDE.md`, which make every session use the skill for plans
   - whether to install artifact-style too, the matching look for every other Artifact page (plans look the same either way)
3. Runs `python install.py` from `skills/better-plans` with your answers as flags: `--instructions` or `--no-instructions`, and `--with-artifact-style` or `--no-artifact-style` (`python3` on macOS and Linux). For example, `python install.py --instructions --with-artifact-style`.
4. Checks it ends with **Setup complete**, that `~/.claude/skills/better-plans/SKILL.md` now exists, and that `~/.claude/settings.json` has a `SessionStart` hook whose command is `python -I "<home>/.claude/tools/better-plans/skill/session_resume.py"` (`python3` on macOS and Linux), with your home folder's full path. If you chose artifact-style, also that `~/.claude/skills/artifact-style/SKILL.md` exists.

**You do:**

1. Start a new Claude Code session, so it loads the skill and the hook.

## Install

1. **Python 3.9 or newer.** Check with `python --version` (on macOS and Linux, `python3 --version`). If it's missing, on Windows run `winget install Python.Python.3.13` and open a new terminal; on macOS, `brew install python`.
2. From this folder, run `python install.py` (PowerShell or bash). It:
   - puts the tool at `~/.claude/tools/better-plans`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux), so a `git pull` updates the tool. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - links `~/.claude/skills/better-plans` to the `skill` folder in `~/.claude/tools/better-plans`
   - adds the light plans' `SessionStart` hook to `~/.claude/settings.json`, running `~/.claude/tools/better-plans/skill/session_resume.py`. It backs the file up first and leaves your other settings alone.
   - shows these lines and asks whether to add them to `~/.claude/CLAUDE.md`, between two marker lines:

     ```markdown
     - Whenever you make a plan (in chat or in plan mode), publish the finished plan as an Artifact page
       with the better-plans skill, and give the link. Load better-plans first, before making, revising,
       marking progress on or reading any plan, plan mode included. In plan mode, publish once the plan
       is approved. When the plan changes, update the same page so it keeps one URL.
     ```

     They make the skill apply every time, plan mode included, rather than only when its description happens to match what you asked. `--instructions` or `--no-instructions` answers ahead of time. With no terminal to ask in (as when Claude Code runs the install without either), it leaves them out and says how to add them.
   - saves what it installed to `~/.claude/tools/better-plans.install.json`
   - asks whether to install [artifact-style](https://github.com/masfew/toolbox#artifact-style) too, if it's in the same clone and not installed yet. Yes runs artifact-style's own `install.py`, which asks about its own `CLAUDE.md` lines. `--with-artifact-style` or `--no-artifact-style` answers ahead of time; with no terminal and neither flag, it leaves artifact-style out and says how to add it.
3. Start a new Claude Code session.

The install is safe to rerun. It never adds an entry twice, and it leaves the rest of `settings.json` and `CLAUDE.md` alone, backing each up before any change.

## Configuration

There are no settings. To change the look or the rules, see [How It Works](#how-it-works).

## Usage

Ask for a plan as usual. Claude builds the page, publishes it as an Artifact titled with the project and topic, and gives you the link:

- *"Make a plan for adding dark mode to the notes app."* A page with a summary, a phase-by-phase overview, step cards and any risks or diagrams the plan needs.
- *"Mark 2.3 done and add an outcome to 2.4: shipped behind a flag."* The same page updates within a second or two, with a new version number. Updates never republish the page.
- *"Rename 4.2 to Settings Menu"*, *"add a step after 3.1: …"*, *"move Search ahead of Sharing"*: steps renumber themselves, and step numbers mentioned in the text follow their steps.
- *"Add a future idea: calendar sync."* An undecided idea card on the Future Ideas board.
- *"I've updated my future ideas."* After you press ✓ or ✕ on idea cards, or wrote changes in a planned feature's edit box, Claude turns accepted ideas into planned features with steps and makes your edits.
- *"Read the plan and build step 3.2."* A session reads only the outline and the parts it needs, not the whole page.
- *"Build the selected phases in the <plan>."* After you tick phases in the overview (see Building Selected Phases below).

On the page, a round button in the bottom-right corner takes you to the next step that isn't finished. Finished phases fold up in the overview, and once the whole build plan is finished, or 10 or more planned features are done, those fold together into one row. Drag a planned feature by the dots left of its header to change its order.

**Snapshots.** A plan's content lives in the page's database, and the page builds itself from it every time it opens. The page's HTML is a snapshot for people who can't load the database (signed out, or a tool that doesn't run the page's script). When you open a plan that has changed and whose snapshot is over a day old (or more than 30 updates behind), the page saves a fresh snapshot by itself. The **Save Snapshot** line under the summary saves one whenever you want.

**Batches**, only when you ask for them: a long plan can be grouped into batches, each usually several whole phases that one fresh session builds back to back, pausing where you're needed. A batch ends only where the work has to wait on something, such as a week of use, or the session would run too long. Then *"build the next batch in the <plan>"* is all a new session needs.

**Building selected phases.** Each unfinished planned feature in the overview has a tick box in its phase cell, and so does each unfinished core phase in a plan without batches. Tick the ones you want built next, in any order, then tell a new session *"build the selected phases in the <plan>"*. The session claims them all at once, so another session can't take them: each shows "Claimed" with the session's name in place of its box, and a Release button for a session that stopped without finishing. It works out the order from the phases' dependencies, asks you first if a ticked phase depends on unfinished work you didn't tick, then builds them one at a time, handing each phase to a worker subagent while it checks the work and keeps the plan up to date. The same happens when you name two or more phases for one session.

### Light Plans

For a long piece of work in one session, Claude keeps a light plan: a short Markdown file holding the goal, where things stand, decisions, steps, key files and dead ends. It isn't a page. Claude makes one when you ask for a light plan, a session plan or session notes, or by itself once the work has three or more steps that change files; *"make a plan"* still makes a full plan page.

The point is the `/clear` habit. Letting a long session compact is one of the most expensive requests it makes; `/clear` costs nothing. With a light plan, at a natural break Claude says the plan is current, you run `/clear`, and the hook pastes the light plan back in so Claude carries on where it was. Say *"save state"* any time to bring it up to date, or *"make this a full plan"* to turn it into a plan page.

Light plans live in the desktop app's session notes folder (`%APPDATA%\Claude\side-session-notes\<session id>\session-plan.md` on Windows). The hook deletes ones not changed for 14 days.

## How It Works

- `skill/SKILL.md` is what every request loads: which file to read for which request, headings, record and lookup updates, reading a plan for context, and the plan source format. The other `skill/*.md` files are read only when a request needs them: `making.md` (new plans), `ideas.md` and `selections.md` (the Future Ideas board), `building.md` (building ticked phases), `snapshots.md`, `batches.md`, `light.md` (light plans), and `older-plans.md` and `older-selections.md` (plans published before the database pages, which are HTML pages republished to change them).
- **Making a plan:** Claude writes a short plan source (title, summary, sections, phases, steps and ideas under light headings), and `skill/plan.py new` builds the page and the plan's database entries from it. Claude publishes the page with `skill/plan.css` and `skill/plan.js` beside it and saves the entries in one write.
- **Updating a plan:** every update is one small record in the page's database (its `statuses` collection), written by `skill/plan.py record`. Records name steps by number or by name, as you'd say them. The page replays the records over the plan's entries and works out every number itself. `skill/dbplan.py` holds the plan model and page builder, and `skill/plan.js` has their twin for the page; tests keep the two identical.
- **The look and behaviour** live in `skill/plan.css` and `skill/plan.js`, published beside each plan. A published plan keeps the copies it was published with; ask Claude to refresh a plan's look to give it newer ones.
- **Light plans:** `skill/session_resume.py` is the `SessionStart` hook. After `/clear` or a compaction it pastes the session's light plan into the new context, and on every start it deletes light plans older than 14 days. In the desktop app it logs one line per session start to `~/.claude/better-plans-session-resume.log`; outside it, it does nothing.
- `skill/evals/triggers.json` holds 20 test prompts, 10 that should load the skill and 10 near-misses that shouldn't, for checking the description after a change.
- `tests/` holds the test suite (`python -I tests/run_all.py`), with a made-up plan in `tests/sample-db`. `CLAUDE.md` in this folder has the notes for anyone changing the skill.

Everything the install adds points at `~/.claude/tools/better-plans`, never at the folder you installed from: the skill link and the hook. Only `~/.claude/tools/better-plans` itself points at that folder (or holds a copy of it). The install keeps a record of what it added in `~/.claude/tools/better-plans.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `better-plans-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell or bash):

```bash
git pull
cd skills/better-plans
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout better-plans-v1.0.0
cd skills/better-plans
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `better-plans` folder inside it. The install copies the tool to `~/.claude/tools/better-plans`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed (for example when a `git pull` reorganises the repo), what happens depends on how it was installed. In a git clone, `~/.claude/tools/better-plans` is a link to the folder, so the link is left pointing at a folder that's gone and the tool's hooks and skills stop working until you rerun `python install.py` from the new folder, which points the link there and takes out anything stale. An install made as a copy (an unzipped release, or `--copy`) keeps working as it is, and rerunning from the new folder switches it over.

Published plans keep the `plan.css` and `plan.js` they were published with, so an update doesn't change them. Ask Claude to refresh a plan's look to give it the new files.

## Uninstall

From the tool's folder (PowerShell or bash):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/better-plans` instead.

This removes everything the install added: the skill link, the hook in `~/.claude/settings.json`, the lines in `~/.claude/CLAUDE.md`, `~/.claude/tools/better-plans` and its install record, even if the install was made from a different folder. `~/.claude/settings.json` and `~/.claude/CLAUDE.md` are backed up before they're changed, and the `settings.json.bak-<date>-<time>` and `CLAUDE.md.bak-<date>-<time>` backups it and the install made stay in place; delete them yourself if you don't need them. It leaves artifact-style installed; remove that with its own `install.py --remove`. Your published plans stay as they are, and the hook's log, `~/.claude/better-plans-session-resume.log`, can be deleted by hand.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Plans come out as plain chat text or a hand-made page | The session started before the install, or the `CLAUDE.md` lines were left out, so the skill only loads when its description matches | Start a new session. Rerun `python install.py --instructions` to add the lines |
| Claude doesn't list the `better-plans` skill | Claude Code reads skills when a session starts | Start a new session, or restart Claude Code |
| Publishing a plan fails with a capabilities error | The account can't give Artifact pages a database | Plans need Artifacts with the `db`, `user` and `artifact` capabilities; without them the skill can't publish |
| A light plan isn't restored after `/clear` | The session isn't in the desktop app, or the hook wasn't loaded | Light plans need the desktop app. Start a new session after installing; check `~/.claude/better-plans-session-resume.log` has a line for the session (the file appears with the first session start after the install) |
| A plan page shows the old look after an update | Published plans keep the `plan.css` and `plan.js` they were published with | Ask Claude to refresh the plan's look |
| `FAILED: ~/.claude/tools/better-plans exists but isn't this tool` | Something else is in that folder | Move it elsewhere, then rerun |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.5.0: Batches group whole phases into as few sessions as the plan allows. A batch now ends only where the work waits on something outside the plan or the session would run too long; approvals, hands-on checks and decisions are pauses inside a batch, and the Batches table says why each batch ends. Plans already split into batches keep their batches until you ask to regroup them.
- 1.4.0: Plans get build boxes. Tick the planned features (and, in a plan without batches, the core phases) you want built next, and tell a new session to build the selected phases. It claims them all in one write, so no other session can take them, shows them as Claimed with a Release button, and builds them in dependency order as an orchestrator, one worker subagent per phase. Naming two or more phases for one session works the same way. Published plans get the boxes the next time their look is refreshed.
- 1.3.1: The install no longer crashes when Claude Code runs it without --instructions or --no-instructions. Windows reports the empty input Claude Code's tools give a command as a terminal, so the install asked whether to add its CLAUDE.md lines and then stopped with an EOFError. It now sees there's no one to answer, leaves the lines out and prints the command that adds them.
- 1.3.0: Plans run in batches no longer have side batches, which ran beside the others with a dashed "Requires Batch N" badge and only when named. Every batch is now numbered and runs in order, and work that has to wait on something (such as a week of everyday use) ends its batch, with the next batch's row saying what it waits on. Existing plans with a side batch keep working as they are.
- 1.2.0: Finished phases in the plan overview now also fold together. Once every core phase is finished, the build plan folds into one row; once 10 or more planned features at the top of Future Ideas are done, they fold into one row, with the ones in progress, not started or skipped left below it. Opening the finished features scrolls down to the last of them and the next one or two, and hiding them (from a row at the bottom) scrolls back up. Published plans pick this up the next time their look is refreshed.
- 1.1.0: A phase or planned feature whose status moves it into another group (finished, reopened, skipped or brought back) now moves only as far as it must, to the end of its new group going up or the top going down, and stays there, instead of jumping back to wherever it first sat. Published plans pick this up the next time their look is refreshed.
- 1.0.0: First public version.
