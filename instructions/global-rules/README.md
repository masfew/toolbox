# global-rules

Version 3.0.0. See the [changes](#changes) at the end.

## What It Does

A rule for every Claude Code session, added to your `~/.claude/CLAUDE.md`: every subagent Claude starts runs on a model and effort matched to its work, instead of on the session's own model, which is often the largest at high effort. Subagents for finding and reading files then cost a fraction of what they would, and the largest model is kept for work that needs it.

| File | What it changes |
|---|---|
| `rules/subagent-model-and-effort.md` | Every subagent gets a model and effort picked from a table by the kind of work: a small model for finding and reading, a mid-size one for summaries, routine edits and code that needs judgement, the largest only when the result has to match a full session or the problem is hard. Claude decides whether a task needs subagents at all, and asks before more than 10 for one task, more than 5 on the largest model, or a test run that starts Claude sessions |

Before and after, for a session asked to find every caller of a function across a large codebase:

```text
Without: one subagent on the session's model (often the largest, at high effort) reads the codebase
With:    one subagent on the small model at low effort does the same search and reports the callers
```

Until 3.0.0 the tool also held `decide-dont-ask.md` and `next-step-buttons.md`, rules on when a session decides for itself and how it asks. They're no longer part of it: see [Changes](#changes).

## Requirements

- Claude Code (the desktop app or the terminal CLI)
- Python 3.9 or newer, for the installer
- Tested on Windows 11. macOS and Linux: untested.

## Quick Start

From the root of the cloned repo (PowerShell, or bash with `python3` on macOS and Linux):

```bash
cd instructions/global-rules
python install.py
```

It shows the import lines it would add to `~/.claude/CLAUDE.md`, asks first, and ends with **Setup complete**. Start a new Claude Code session.

## Install with Claude Code

Say to Claude Code: *"Clone https://github.com/masfew/toolbox and install global-rules."* With a clone already there, open Claude Code in it and say *"Install global-rules."* Claude follows the repo's install rules: it does the steps under Claude does, and reads out the steps under You do one at a time, waiting for each.

**Claude does:**

1. Checks Python 3.9 or newer is installed, and asks before installing it if it's missing, with the command from [Install](#install) step 1. On Windows, run `Get-Command python` (PowerShell) first: if it points into `WindowsApps`, `python` may be the Python install manager, whose first run downloads and installs Python, so tell the person and wait for a yes before running `python` at all. Then `python --version` (`python3 --version` on macOS and Linux) shows the version.
2. Tells you what the rule changes (the table in [What It Does](#what-it-does)).
3. Shows you the import lines the install adds to `~/.claude/CLAUDE.md` (in [Install](#install) step 2) and asks whether to add them.
4. Runs the install from `instructions/global-rules` (`python3` on macOS and Linux), and checks it ends with **Setup complete** and that `~/.claude/CLAUDE.md` now holds the import line (PowerShell, or bash with `python3` on macOS and Linux):

   ```bash
   python install.py --instructions
   ```

**You do:**

1. Start a new Claude Code session, so it loads the rule.

## Install

1. **Python 3.9 or newer.** Check with `python --version` (on macOS and Linux, `python3 --version`). If it's missing, on Windows run `winget install Python.Python.3.13` and open a new terminal; on macOS, `brew install python`.
2. From this folder, run `python install.py` (PowerShell or bash). It:
   - puts the tool at `~/.claude/tools/global-rules`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux), so a `git pull` updates the rule. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - shows this line and asks whether to add it to `~/.claude/CLAUDE.md`, between two marker lines:

     ```markdown
     @~/.claude/tools/global-rules/rules/subagent-model-and-effort.md
     ```

     Claude Code reads the imported file as if its text were in `CLAUDE.md`. `--instructions` or `--no-instructions` answers the question ahead of time. With no terminal to ask in (as when Claude Code runs the install without either), it leaves them out and says how to add them.
   - saves what it installed to `~/.claude/tools/global-rules.install.json`
3. Start a new Claude Code session.

The install is safe to rerun. It never adds a line twice, takes out the import lines of rule files removed in 3.0.0, and leaves the rest of `CLAUDE.md` alone, backing it up before any change.

## Configuration

There are no settings. `--only subagent-model-and-effort` still works, for scripts written for earlier versions. To change the rule itself, see [Adding Your Own Cases](#adding-your-own-cases).

## Usage

There's nothing to run once it's installed. You'll see the difference in what sessions do:

- **A search across a large codebase** goes to a subagent on the small model at low effort.
- **A bug review or a change that needs judgement** goes to the mid-size model at high effort, and the largest model only when the work has to match a full session.
- **Whether to use subagents, and how many up to 10,** is Claude's call, even when you say "use subagents if it helps".
- **A big fan-out or test run**, meaning more than 10 subagents for one task, more than 5 on the largest model, or any test or eval that starts Claude sessions, waits for your go-ahead first, since it can use a large share of a smaller plan's limits.

## How It Works

- `rules/subagent-model-and-effort.md` holds the "Subagent model and effort" section and its table. Claude Code's Agent tool sets a subagent's `effort` only when your instructions ask for it, so the rule says it's your standing instruction for both `model` and `effort`.

Everything the install adds points at `~/.claude/tools/global-rules`, never at the folder you installed from: the import lines in `~/.claude/CLAUDE.md`. Only `~/.claude/tools/global-rules` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/global-rules.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Adding Your Own Cases

Add to the rule rather than editing a copy, so updates still reach you. Write your own cases in `~/.claude/CLAUDE.md`, outside the marked block, naming the section they add to, for example:

```markdown
## Additions to the global rules
- Subagents: my sessions run on the mid-size model, so use `haiku` for every row except the last.
```

Claude reads them together with the imported rule. Editing a rule file in the clone changes it for you too, but a `git pull` can then conflict with your edit.

## Updating

Read the [changes](#changes) first for anything that needs you to do something. Each version is also on the repo's [releases page](https://github.com/masfew/toolbox/releases), tagged `global-rules-v<version>`, with its notes and a zip of this folder.

From the root of the cloned repo, pull the new version, then rerun the install (PowerShell or bash):

```bash
git pull
cd instructions/global-rules
python install.py
```

To stay on a version, check out its tag instead, then rerun the install (PowerShell or bash):

```bash
git fetch --tags
git checkout global-rules-v1.0.0
cd instructions/global-rules
python install.py
```

This moves the whole clone, so every other tool in it goes back to that point too. To return to the latest version, run `git checkout main` and `git pull`, then rerun the install. To keep this tool on one version without moving the others, download its zip from the release instead, unzip it, and run `python install.py` from the `global-rules` folder inside it. The install copies the tool to `~/.claude/tools/global-rules`, so the unzipped folder can be deleted afterwards.

If the tool's folder moves or is renamed (for example when a `git pull` reorganises the repo), what happens depends on how it was installed. In a git clone, `~/.claude/tools/global-rules` is a link to the folder, so the link is left pointing at a folder that's gone and the rule stops loading until you rerun `python install.py` from the new folder, which points the link there and takes out anything stale. An install made as a copy (an unzipped release, or `--copy`) keeps working as it is, and rerunning from the new folder switches it over.

## Uninstall

From the tool's folder (PowerShell or bash):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/global-rules` instead.

This removes everything the install added: the import lines in `~/.claude/CLAUDE.md`, `~/.claude/tools/global-rules` and its install record, even if the install was made from a different folder. Your own additions outside the marked block stay, and so do the `CLAUDE.md.bak-<date>-<time>` backups the install made before each change; delete those yourself if you don't need them.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Subagents still run on the session's model | The session started before the install, or the import line was left out | Start a new session. Check `~/.claude/CLAUDE.md` holds the line; if not, rerun `python install.py --instructions` |
| "left this tool's lines out" after the install | There was no terminal to ask in, as when Claude Code runs it | Rerun with `--instructions` |
| `FAILED: ... was removed from global-rules in 3.0.0` | `--only` named `decide-dont-ask` or `next-step-buttons`, or your install imported only those | Run `python install.py --only subagent-model-and-effort` to keep the subagent rule, or `python install.py --remove` |
| `FAILED: ~/.claude/tools/global-rules exists but isn't this tool` | Something else is in that folder | Move it elsewhere, then rerun |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 3.0.0: `rules/decide-dont-ask.md` is gone, so the tool holds only the subagent rule. Its author moved "Decide, don't ask", "Questions get answers" and "Context first, question last" into their own instructions to tailor them to one workflow. The last public version is tagged `global-rules-v2.0.1`; copy its `rules/decide-dont-ask.md` into your own `CLAUDE.md` if you want to keep using it. The subagent rule now says itself that a test run starting Claude sessions needs your go-ahead, which it had left to `decide-dont-ask.md`. **To do:** after `git pull`, rerun `python install.py` from this folder, which takes the old import lines out of `~/.claude/CLAUDE.md`. Until then they point at files that no longer exist. If you had only `decide-dont-ask`, the rerun stops and says to run `--remove` or `--only subagent-model-and-effort`.
- 2.0.1: The subagent rule is shorter, with no change to which model and effort a subagent gets. It drops what Claude Code's own Agent tool description now says (when subagents help, and doing small lookups directly), and leaves asking before a test run that starts Claude sessions to case 2 of "Decide, don't ask", which already had it. It keeps the 10 and 5 subagent limit, so it still works installed on its own. Case 2 now says a test run that starts Claude sessions needs a go-ahead "even a cheap one on a small model", since without the subagent rule repeating it, sessions sometimes ran a small Haiku test suite unasked. Nothing to do: `git pull` picks it up.
- 2.0.0: `rules/next-step-buttons.md` is gone: its rules are one bullet in the "Context first, question last" section of `rules/decide-dont-ask.md` (each option or next-step button does exactly what its label says, one action per option, separate questions for separate changes). Most of the file was about the desktop app's next-step box; the bullet keeps what applies to every question. **To do:** after `git pull`, rerun `python install.py` from this folder, which takes the old import line out of `~/.claude/CLAUDE.md` (and adds `decide-dont-ask` if you had only the buttons file). Until then that line points at a file that no longer exists. `--only next-step-buttons` still works and installs `decide-dont-ask`.
- 1.5.0: Two exceptions in case 2 of "Decide, don't ask", where sessions asked though you'd want them to go ahead: one short session on a small model to check a fact (a probe costing a cent or so) isn't a test run, and installing the tools the project's own tool manifest already lists (a `rokit.toml`, `package.json` or similar) isn't installing outside the project. The subagent rule's test-run line points to the probe exception. Nothing to do: `git pull` picks it up.
- 1.4.0: "Questions get answers, not action cards" now covers proposals: when you ask for one, the session sends it in the reply and stops, with no question or button asking whether to apply it. Nothing to do: `git pull` picks it up.
- 1.3.0: The subagent rule now starts with when subagents help, says whether to use any is the session's call ("use subagents if it helps" doesn't require them), and drops "fewer subagents save more than cheaper ones", which made sessions avoid them for everyday work. The limit is now a hard line: up to 10 subagents for one task, at most 5 on the largest model, are the session's call, and more than that, or any test or eval that starts Claude sessions, needs your go-ahead. Case 2 of "Decide, don't ask" says the same, in place of "dozens of sessions or subagents". Nothing to do: `git pull` picks it up.
- 1.2.0: A third rule file, `rules/next-step-buttons.md`: each next-step button does exactly what its label says, with one action per button, and the same goes for a question's options in the terminal. A first install takes it with the other two. An existing install keeps the files it chose until you rerun with `--only`, so to add it: `python install.py --only decide-dont-ask subagent-model-and-effort next-step-buttons` (or with only the files you want).
- 1.1.0: Sessions now ask before a run that would use a large share of the plan's usage limits, such as a test suite, eval or subagent fan-out that starts dozens of sessions. Case 2 of "Decide, don't ask" used to say "spending beyond the session's normal Claude usage", which reads as money, so a big test run on a smaller plan could pass as normal usage. The subagent rule's more-than-10 line now says the same. Nothing to do: `git pull` picks it up.
- 1.0.1: The install no longer crashes when Claude Code runs it without --instructions or --no-instructions. Windows reports the empty input Claude Code's tools give a command as a terminal, so the install asked whether to add its CLAUDE.md lines and then stopped with an EOFError. It now sees there's no one to answer, leaves the lines out and prints the command that adds them.
- 1.0.0: First public version.
