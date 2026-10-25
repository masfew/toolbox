# global-rules

Version 1.1.0. See the [changes](#changes) at the end.

## What It Does

Rules for every Claude Code session, added to your `~/.claude/CLAUDE.md` one file at a time. They cut the two things that waste the most time when you run sessions without watching them: sessions that stop to ask about choices they could make themselves, and subagents that run on the largest model for work a small one does as well.

There are two rule files. Install one or both:

| File | What it changes |
|---|---|
| `rules/decide-dont-ask.md` | Claude makes implementation choices itself and names them in the reply, and asks only when you'd notice the result, it reaches outside the project (including a run that would use a large share of your plan's usage limits), it could be unsafe, or it isn't confident. A question you ask gets an answer rather than an offer to do something. When it does ask, the context comes first and the question last |
| `rules/subagent-model-and-effort.md` | Every subagent Claude starts gets a model and effort picked from a table by the kind of work: a small model for finding and reading, a mid-size one for summaries and routine edits, the largest only when the result has to match a full session |

Before and after, for a session asked to add a "clear finished" button to a to-do app:

```text
Without: "Should the button go in the header or the footer? And should it ask for confirmation?"
         (the session stops until you answer)
With:    "Added Clear finished to the footer, next to the item count, since the other list
          actions are there. It asks for confirmation first, because it deletes items."
```

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

1. Checks Python 3.9 or newer is installed (`python --version`, or `python3 --version` on macOS and Linux), and asks before installing it if it's missing, with the command from [Install](#install) step 1.
2. Tells you what each rule file changes (the table in [What It Does](#what-it-does)), and asks which you want: both, or only one.
3. Shows you the import lines the install adds to `~/.claude/CLAUDE.md` (in [Install](#install) step 2) and asks whether to add them.
4. Runs the install from `instructions/global-rules` (`python3` on macOS and Linux), naming the files you chose, and checks it ends with **Setup complete** and that `~/.claude/CLAUDE.md` now holds one line per file:
   - both: `python install.py --instructions --only decide-dont-ask subagent-model-and-effort`
   - only the decide-don't-ask rules: `python install.py --instructions --only decide-dont-ask`
   - only the subagent rules: `python install.py --instructions --only subagent-model-and-effort`

   Naming the files every time also works on a rerun, when you add or drop one later.

**You do:**

1. Start a new Claude Code session, so it loads the rules.

## Install

1. **Python 3.9 or newer.** Check with `python --version` (on macOS and Linux, `python3 --version`). If it's missing, on Windows run `winget install Python.Python.3.13` and open a new terminal; on macOS, `brew install python`.
2. From this folder, run `python install.py` (PowerShell or bash). It:
   - puts the tool at `~/.claude/tools/global-rules`. In a git clone that's a link to this folder (a directory junction on Windows, which needs no admin rights; a symlink on macOS and Linux), so a `git pull` updates the rules. From an unzipped release it's a copy, and the unzipped folder can be deleted afterwards. `--copy` or `--link` overrides the choice.
   - shows these lines and asks whether to add them to `~/.claude/CLAUDE.md`, between two marker lines:

     ```markdown
     @~/.claude/tools/global-rules/rules/decide-dont-ask.md
     @~/.claude/tools/global-rules/rules/subagent-model-and-effort.md
     ```

     Claude Code reads each imported file as if its text were in `CLAUDE.md`. `--only decide-dont-ask` or `--only subagent-model-and-effort` adds just that line. `--instructions` or `--no-instructions` answers the question ahead of time. With no terminal to ask in (as when Claude Code runs the install without either), it leaves them out and says how to add them.
   - saves what it installed to `~/.claude/tools/global-rules.install.json`
3. Start a new Claude Code session.

The install is safe to rerun. It never adds a line twice, keeps the files you chose last time unless you pass `--only` again, and leaves the rest of `CLAUDE.md` alone, backing it up before any change.

## Configuration

| Setting | What it does | Default | Example |
|---|---|---|---|
| `--only` | Which rule files to import, one or more names separated by spaces. It replaces the earlier choice, so use it to add or drop a file later | Both on a first install; on a rerun, the ones already imported | `python install.py --only subagent-model-and-effort`, or `--only decide-dont-ask subagent-model-and-effort` for both |

To change the rules themselves, see [Adding Your Own Cases](#adding-your-own-cases).

## Usage

There's nothing to run once it's installed. You'll see the difference in what sessions do:

- **A session building a feature** picks the file layout, the library already in the project and the error handling itself, and says in a line what it chose and why. It still asks before changing what you or your users would see, such as a button's label or a game's prices.
- **"What's left on this?"** gets the list, not a question asking whether to start on it.
- **A question it does need to ask** comes after the explanation: what it found and what each option changes, then the question.
- **A search across a large codebase** goes to a subagent on the small model at low effort, and Claude says how many subagents and which model before starting more than 10.
- **A big test run or fan-out**, such as an eval that starts dozens of sessions, waits for your go-ahead first, since it can use a large share of a smaller plan's limits. A few subagents and checks that start no sessions go ahead without asking.

## How It Works

- `rules/decide-dont-ask.md` holds three sections: "Questions get answers, not action cards", "Decide, don't ask" and "Context first, question last". They're installed together, since the last one says how a question is asked once the second says one is needed.
- `rules/subagent-model-and-effort.md` holds the "Subagent model and effort" section and its table.
- The rules mention the Claude desktop app's next-step box and session cards where they apply, and say what to do instead in the terminal.

Everything the install adds points at `~/.claude/tools/global-rules`, never at the folder you installed from: the import lines in `~/.claude/CLAUDE.md`. Only `~/.claude/tools/global-rules` itself points at that folder (or holds a copy of it). The install also keeps a record of what it added, in `~/.claude/tools/global-rules.install.json`. A rerun reads it first and takes out anything the earlier install added that the new one doesn't, and `--remove` reads it to undo everything.

## Adding Your Own Cases

Add to the rules rather than editing a copy, so updates still reach you. Write your own cases in `~/.claude/CLAUDE.md`, outside the marked block, naming the section they add to, for example:

```markdown
## Additions to the global rules
- Decide, don't ask, case 1 also covers the release notes my team posts: ask before changing their format.
- Subagents: my sessions run on the mid-size model, so use `haiku` for every row except the last.
```

Claude reads them together with the imported rules. Editing a rule file in the clone changes it for you too, but a `git pull` can then conflict with your edit.

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

If the tool's folder moves or is renamed (for example when the repo is reorganised), the install keeps working as it is. Rerunning `python install.py` from the new folder points `~/.claude/tools/global-rules` there and takes out anything stale.

## Uninstall

From the tool's folder (PowerShell or bash):

```bash
python install.py --remove
```

If you installed from a release zip and deleted the unzipped folder, run the same command from `~/.claude/tools/global-rules` instead.

This removes everything the install added: the import lines in `~/.claude/CLAUDE.md`, `~/.claude/tools/global-rules` and its install record, even if the install was made from a different folder. Your own additions outside the marked block stay, and so do the `CLAUDE.md.bak-<date>` backups the install made before each change; delete those yourself if you don't need them.

## Troubleshooting

| Problem | Cause | Fix |
|---|---|---|
| Sessions still stop to ask about small choices | The session started before the install, or the import lines were left out | Start a new session. Check `~/.claude/CLAUDE.md` holds the lines; if not, rerun `python install.py --instructions` |
| "left this tool's lines out" after the install | There was no terminal to ask in, as when Claude Code runs it | Rerun with `--instructions` |
| `FAILED: no rule file called ...` | The name after `--only` isn't one of the rule files | Use `decide-dont-ask` or `subagent-model-and-effort` |
| Claude asks about something you'd rather it decided | Your own instructions or the conversation say to consult you more, which wins over these rules, or the choice falls in one of the four cases | Say so in the conversation, or add a case of your own as [Adding Your Own Cases](#adding-your-own-cases) shows |
| `FAILED: ~/.claude/tools/global-rules exists but isn't this tool` | Something else is in that folder | Move it elsewhere, then rerun |

## License

MIT. See the [LICENSE](https://github.com/masfew/toolbox/blob/main/LICENSE) file at the root of the repo.

## Changes

- 1.1.0: Sessions now ask before a run that would use a large share of the plan's usage limits, such as a test suite, eval or subagent fan-out that starts dozens of sessions. Case 2 of "Decide, don't ask" used to say "spending beyond the session's normal Claude usage", which reads as money, so a big test run on a smaller plan could pass as normal usage. The subagent rule's more-than-10 line now says the same. Nothing to do: `git pull` picks it up.
- 1.0.1: The install no longer crashes when Claude Code runs it without --instructions or --no-instructions. Windows reports the empty input Claude Code's tools give a command as a terminal, so the install asked whether to add its CLAUDE.md lines and then stopped with an EOFError. It now sees there's no one to answer, leaves the lines out and prints the command that adds them.
- 1.0.0: First public version.
