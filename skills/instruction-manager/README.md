# instruction-manager

Version 1.3.0. See the [changes](#changes) at the end.

## What It Does

A Claude Code skill that every session loads before it creates, changes or audits the instructions your sessions follow: your own skills, your global `~/.claude/CLAUDE.md`, each project's `CLAUDE.md`, and READMEs that sessions are told to follow. Skills and instruction files drift because many sessions each add a little: a rule copied into a second file, a description that quietly stops loading its skill, a CLAUDE.md that doubles in size. This skill makes every edit read the whole file first, put each rule in one place, and measure the result: words added or removed, copied sentences, broken links, and trigger test scores before and after.

For skills it sits on top of Anthropic's skill-creator, using its test formats, and adds a house style, trigger tests that stay with each skill and rerun when its description changes, a size and duplicate check on every edit, and audits of skills you already have. For instruction files it adds word budgets, the same duplicate and broken-path checks, and a rerun of a section's tests when that section changes. An edit guard hook catches the quick one-line edit made without loading the skill.

Tests that start Claude sessions use your plan's usage limits, so the skill always asks how to run them first, with the real cost for that skill:

```text
How should I test this change?
  1. Quick: about 20 short sessions on Haiku, about 1 minute. Fine on any plan, including Pro.
  2. Standard (Recommended): about 40 to 60 short sessions on your default model, about 2 minutes.
  3. Full: about 60 sessions on Opus plus the behaviour tests, about 2 minutes plus the tests. Only on Max 5x or 20x.
  4. Skip testing: no sessions. The change goes in without being tested.
```

## Requirements

- Claude Code (the desktop app or the terminal CLI)
- Python 3.9 or newer
- For trigger tests: the Claude Code CLI, signed in (the skill finds the CLI on your PATH, or the copy the Claude desktop app bundles on Windows)
- Optional: Anthropic's skill-creator skill. When it's installed, `check_skill.py` also runs its `quick_validate.py`.
- Tested on Windows 11. macOS and Linux: untested.

## Quick Start

From the root of the cloned repo (PowerShell, or bash with `python3` on macOS and Linux):

```bash
cd skills/instruction-manager
python install.py
```

It ends with **Setup complete**. Start a new Claude Code session.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install instruction-manager."* With a clone already there, open Claude Code in it and say *"Install instruction-manager."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks Python 3.9 or newer is installed, and asks before installing it if it's missing, with the command from [Install](#install) step 1. On Windows, run `Get-Command python` (PowerShell) first: if it points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python, so tell the person and wait for a yes before running `python` at all. Then `python --version` (`python3 --version` on macOS and Linux) shows the version.
2. Tells you the install adds a hook to `~/.claude/settings.json` (the [edit guard](#how-it-works)) and asks whether you also want the line it can add to `~/.claude/CLAUDE.md` (shown in [Install](#install)).
3. Runs `python install.py --instructions` or `python install.py --no-instructions` from `skills/instruction-manager` (`python3` on macOS and Linux), following your answer, and checks it ends with **Setup complete**.
4. Runs `python -I ~/.claude/skills/instruction-manager/scripts/check_skill.py --show-config` and tells you which skill folders it covers. If your own skills live somewhere other than `~/.claude/skills`, it offers to add their folders to `~/.claude/instruction-manager.json` ([Configuration](#configuration)).

**You do:**

1. Start a new Claude Code session, so it loads the skill and the hook.
2. For trigger tests, if you haven't used the Claude Code CLI before: run `claude` in a terminal and type `/login` once. The trigger tests start their own Claude Code sessions through the CLI, and a CLI that isn't signed in ends each of them at once. `/login` opens a page in your browser to sign in to your Claude account; when you've finished there, the terminal tells you you're logged in, and you can close it with `/exit`. If `claude` already runs for you without asking you to sign in, skip this.

## Install

1. **Python 3.9 or newer.** Check with `python --version` (on macOS and Linux, `python3 --version`). If it's missing, on Windows run `winget install Python.Python.3.13` and open a new terminal; on macOS, `brew install python`.
2. From this folder, run `python install.py` (PowerShell or bash). It:
   - puts the tool at `~/.claude/tools/instruction-manager`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux), so a `git pull` updates the tool. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - links `~/.claude/skills/instruction-manager` to the `skill` folder in `~/.claude/tools/instruction-manager`
   - adds the edit guard to `~/.claude/settings.json`, after backing it up: a `PreToolUse` hook on Edit, Write, MultiEdit and NotebookEdit that runs `~/.claude/tools/instruction-manager/edit_guard.py`
   - creates `~/.claude/instruction-manager.json` from `config.example.json` if you don't have one yet
   - shows the lines it would add to `~/.claude/CLAUDE.md`, between two marker lines, and asks first:

     ```text
     - Load the instruction-manager skill first whenever you create, change or audit a skill, a
       CLAUDE.md or these global instructions, even for a one-line edit in the middle of other work.
     ```

     `--instructions` or `--no-instructions` answers ahead of time; with no terminal to ask in, it leaves them out and says how to add them. Without them the skill still loads from its description, and the edit guard still catches edits made without it.
   - saves what it installed to `~/.claude/tools/instruction-manager.install.json`
3. If your skills live outside `~/.claude/skills`, list their folders in the config ([Configuration](#configuration)).
4. Start a new Claude Code session.

The install is safe to rerun. It never adds an entry twice, and it leaves your other settings alone.

## Configuration

Settings are read from `~/.claude/instruction-manager.json`, which the install creates from `config.example.json`. Every setting is optional, and a missing file means the defaults. To read another file instead, set the `INSTRUCTION_MANAGER_CONFIG` environment variable to its path (the behaviour tests do this, so they never read your own config). To see what's in effect and which skills it covers, run `python -I ~/.claude/skills/instruction-manager/scripts/check_skill.py --show-config` (PowerShell or bash).

| Setting | What it does | Default | Example |
|---|---|---|---|
| `skill_folders` | Glob patterns for your own skills: `~` for your home folder, `*` for one folder level, `**` for any depth. A folder counts when it holds a `SKILL.md`. `check_skill.py --all`, the duplicate search and the edit guard use it. Skills from plugins aren't yours to edit, so leave their folders out | `["~/.claude/skills/*"]` | `["~/.claude/skills/*", "~/code/my-skills/*"]` |
| `project_skills` | Also count project skills as yours: `.claude/skills/<name>/` in the folder a session or script runs in and every folder above it (your home folder's own `.claude/skills` is covered by `skill_folders` instead) | `true` | `false` |
| `global_instructions` | Files checked as global instructions, against the global word budget. `~/.claude/CLAUDE.md` always counts, and files a listed file imports (its lines that start with an at sign and a path) are followed. The edit guard watches those imported files too, so rules you keep in separate files and import need no setting of their own | `["~/.claude/CLAUDE.md"]` | `["~/.claude/CLAUDE.md", "~/notes/claude-rules.md"]` |
| `skill_prefixes` | Name prefixes that mark a backticked word in an instruction file as a skill name, so a renamed or removed skill is reported | `[]` | `["web-", "docs-"]` |
| `new_skill_homes` | Where a new skill goes, tried in order: the first entry whose `when` fits. A home's own README says how skills there are registered | `[{"when": "anything", "path": "~/.claude/skills/<name>"}]` | `[{"when": "web work", "path": "~/code/web-skills/web-<name>"}, {"when": "anything else", "path": "~/.claude/skills/<name>"}]` |
| `budgets` | Overrides for the size budgets: `description_chars` [minimum (`0` for none), second look, limit], `skill_body_words` [aim, limit], `reference_words` [list sections above, limit], `global_words` and `project_words` [aim, limit] | `[0, 900, 1024]`, `[2000, 3000]`, `[1500, 3000]`, `[4000, 5000]`, `[1000, 3000]` | `{"global_words": [3000, 4000]}` |

A config file that isn't valid JSON, or has a setting the scripts don't know, makes the scripts stop and say what to fix. The edit guard never stops an edit over it: it then watches only `CLAUDE.md` files until the config is fixed.

## Usage

Ask for what you want; the skill loads by itself:

- *"Make a skill for writing patch notes."* It checks no existing skill covers it, picks the folder from `new_skill_homes`, asks what should and shouldn't load it, drafts it to the house style, writes trigger tests, and asks how to test before tuning the description against them.
- *"Add a rule to my deploy-checklist skill: …"* It reads the whole skill, looks for a rule that already covers it, puts the change in its one home, and reports the words added and the check results.
- *"Add to my global instructions that …"* or *"put this in the project's CLAUDE.md"*. It reads the whole file, looks for a rule that already covers it in your global instructions, project files and skills, picks the right home, and reports the words added. When the changed section has tests in an `evals/<section>/` folder beside the file, it asks, then reruns them.
- *"Audit my recipe-app skill"*, *"audit all my skills"* or *"audit my CLAUDE.md files"*. It looks for bloat, drift, wrong claims, contradictions and wordiness, fixes what's clear, and gives you a numbered list of what needs your decision (deleting rules, changing scope).

The scripts also run on their own, from any folder (PowerShell or bash):

```bash
python -I ~/.claude/skills/instruction-manager/scripts/check_skill.py --all
python -I ~/.claude/skills/instruction-manager/scripts/check_instructions.py --all
python -I ~/.claude/skills/instruction-manager/scripts/run_triggers.py ~/.claude/skills/my-skill --dry-run
```

`check_skill.py` prints an `ERROR`, `WARN` or `INFO` line per finding for each skill, such as a description over 1,024 characters or a reference file nothing links to. `run_triggers.py --dry-run` prints what each test tier would cost for that skill and starts nothing; it runs tests only with `--tier quick`, `--tier standard` or `--tier full`.

## How It Works

| File | What it does |
|---|---|
| `skill/SKILL.md` | The new-skill and any-change workflows for skills, tuning a description, and the rule to ask before any test that starts sessions |
| `skill/references/house-style.md` | The rules every skill follows: what goes in a description (only what makes the skill load when it should), word budgets, layout, one home per rule, links, the test files |
| `skill/references/instruction-files.md` | The rules and change workflow for global instructions, project `CLAUDE.md` files and READMEs sessions follow |
| `skill/references/audit.md` | Auditing one skill, all of them, or instruction files |
| `skill/references/test-tiers.md` | The Quick, Standard and Full test tiers, and the question the skill asks before running tests |
| `skill/scripts/check_skill.py` | Fast checks for skills, no sessions started: frontmatter, sizes, links, copied sentences, test files |
| `skill/scripts/check_instructions.py` | Fast checks for instruction files: size with imports against the budget, broken imports, links and paths, skill names that aren't installed, copied sentences, and which tested sections changed. `--all` finds every project `CLAUDE.md` from the folders your sessions have run in |
| `skill/scripts/run_triggers.py` | Runs a skill's `evals/triggers.json` through real Claude sessions at the tier you choose and scores whether the description loads the skill. Replaces skill-creator's `run_eval.py`, which doesn't run on Windows as shipped |
| `skill/scripts/im_config.py` | Reads `~/.claude/instruction-manager.json` (or the file `INSTRUCTION_MANAGER_CONFIG` names) for the scripts and the edit guard |
| `skill/evals/triggers.json`, `skill/evals/last-run.json` | This skill's own trigger tests and its last score |
| `skill/evals/evals.json` | This skill's behaviour tests: a new skill goes to the folder `new_skill_homes` picks, a changed description is tested only after asking, and an audit of all skills asks once with totals |
| `skill/evals/run_behaviour.py` | Runs those behaviour tests as real Claude sessions in scratch projects (3 runs each by default, so 9 sessions on your plan) and grades each run: `python -I skill/evals/run_behaviour.py` |
| `edit_guard.py` | The edit guard hook |
| `tests/test_edit_guard.py` | Offline tests for the edit guard and the import following it shares with `check_instructions.py`: `python tests/test_edit_guard.py`. They move the home folder to a temporary folder first, so they touch none of your files and start no sessions |

**The edit guard** runs before every Edit, Write, MultiEdit and NotebookEdit. When the file is inside one of your skill folders (by real path, so edits through links count), is a `CLAUDE.md` or `CLAUDE.local.md`, or is a file your global instructions import, and the session's transcript shows no load of instruction-manager, it lets the edit through and adds a message telling the session to load the skill before any further edit to that file. It never blocks an edit.

Imported files are found the way Claude Code finds them: the guard reads `~/.claude/CLAUDE.md` and the files `global_instructions` lists, and follows every line that starts with an at sign and a path (`~` for your home folder, other paths relative to the file they're in), up to five imports deep, skipping examples inside code spans and code blocks. It compares real paths, so a rules file imported through a link or junction (for example a tool installed to `~/.claude/tools/<tool>` that links to a git clone) is caught whichever path the edit uses. Imports in a project's `CLAUDE.md` aren't followed. READMEs aren't watched unless the global instructions import them, since most README edits are ordinary documentation. Edits made through shell commands (`sed`, scripts) don't pass through those tools, so the guard doesn't see them.

**Trigger tests** start real, short `claude -p` sessions in an empty scratch folder with your user-level settings, hooks and MCP servers off and editing tools refused, holding description-only copies of every skill in `~/.claude/skills`. A run counts as loading the skill when the session loads it before doing anything else. Scores are saved per tier in the skill's `evals/last-run.json` and compared only within a tier.

Everything the install adds points at `~/.claude/tools/instruction-manager`, never at the folder you installed from: the hook command in `settings.json` and the skill link under `~/.claude/skills`. Only `~/.claude/tools/instruction-manager` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/instruction-manager.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `instruction-manager-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell or bash):

```bash
git pull
cd skills/instruction-manager
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout instruction-manager-v1.0.0
cd skills/instruction-manager
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `instruction-manager` folder inside it. The install copies the tool to `~/.claude/tools/instruction-manager`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed (for example when a `git pull` reorganises the repo), what happens depends on how it was installed. In a git clone, `~/.claude/tools/instruction-manager` is a link to the folder, so the link is left pointing at a folder that's gone and the tool's hooks and skills stop working until you rerun `python install.py` from the new folder, which points the link there and takes out anything stale. An install made as a copy (an unzipped release, or `--copy`) keeps working as it is, and rerunning from the new folder switches it over.

## Uninstall

From the tool's folder (PowerShell or bash):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/instruction-manager` instead.

This removes everything the install added, including the skill link, the edit guard hook, the `CLAUDE.md` lines, `~/.claude/tools/instruction-manager` and its install record, even if the install was made from a different folder. It leaves your config file, `~/.claude/instruction-manager.json`, and each skill's `evals/` folder in place. Delete them yourself if you don't need them. `~/.claude/settings.json` and `~/.claude/CLAUDE.md` are backed up before they're changed, and the `settings.json.bak-<date>-<time>` and `CLAUDE.md.bak-<date>-<time>` backups it and the install made stay in place; delete those yourself too.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| `FAILED: couldn't find the Claude Code CLI` | `claude` isn't on your PATH, and the desktop app's bundled copy wasn't found | Pass `--claude <path to the CLI>`, or set the `INSTRUCTION_MANAGER_CLAUDE` environment variable to it |
| Every trigger run fails, and nothing loads | The CLI isn't signed in, so each session ends at once | Run `claude` in a terminal and type `/login`, then rerun |
| `run_triggers.py` prints estimates and exits with status 2 | No tier was chosen, so it started nothing | Add `--tier quick`, `--tier standard` or `--tier full` |
| `--compare` says there's no earlier run to compare with | Scores are compared only within a tier, and this tier has no saved run yet | Run once with `--save` to set the baseline for that tier |
| `FAILED: ... instruction-manager.json isn't valid JSON` or `has unknown settings` | A typo in the config file | Fix the file as the message says, or delete it to use the defaults |
| `check_skill.py --all` misses your skills | They live outside `~/.claude/skills` | Add their folders to `skill_folders` in the config, then check with `--show-config` |
| The edit guard never says anything | It only speaks when the session hasn't loaded the skill, or the session started before the install | Start a new session; edit a `CLAUDE.md` without loading the skill to see the message |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.3.0: Descriptions hold only what makes a skill load when it should. The house style now tells two kinds of skill apart: one that loads only on words you say or a slash command gets a description naming those words and nothing else, and one that loads on what the task is about keeps the old parts, using only those its trigger tests need. Every clause has to make a test prompt load or stay out, a list of what the skill does is never a description, and there's no minimum length. Tuning a description ends with a trimming pass that cuts clauses one at a time while the score holds. The interview for a new skill asks which kind it is, and audits check descriptions against these rules. `check_skill.py` no longer warns about a short description, and its warning over 900 characters asks you to check each clause; `description_chars` now defaults to `[0, 900, 1024]`, with `0` meaning no minimum.
- 1.2.0: The edit guard now also watches files your global instructions import (their lines that start with an at sign and a path, for example rule files another tool installs), whatever they're named, so a one-line edit to one of them made without the skill is caught like an edit to `~/.claude/CLAUDE.md`. `check_instructions.py` labels such a file a global import and counts its words toward the file that imports it. `~/.claude/CLAUDE.md` and its imports now count as global instructions in `check_instructions.py --all` and the duplicate search even when `global_instructions` doesn't list it, as the Configuration table always said. Imports are now followed five levels deep, as Claude Code does, instead of stopping after the first five files, so a file with more than five imports is counted in full. New offline tests: `tests/test_edit_guard.py`.
- 1.1.0: The skill now has behaviour tests (`skill/evals/evals.json`, run by `skill/evals/run_behaviour.py`), which check that a new skill goes to the folder `new_skill_homes` picks, that a changed description is tested only after asking, and that an audit of all skills asks once with totals. The `INSTRUCTION_MANAGER_CONFIG` environment variable can now point the scripts and the edit guard at another config file. Two fixes the tests found: a new skill is drafted only after you've answered the interview questions, and an audit of all skills edits nothing until you've chosen how to test, so each starting score comes from the unedited skill. An audit of a few small skills can now review them without subagents, and says so.
- 1.0.0: First public version.
