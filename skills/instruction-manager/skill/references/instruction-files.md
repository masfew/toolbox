# Instruction files

The rules and the change workflow for the global instructions, project `CLAUDE.md` files and READMEs that sessions follow. They load before any skill and, unlike a skill, nothing decides whether they apply: every line costs every session, and a wrong or contradicting line steers every session. The same drift that hits skills hits these files, usually through a one-line rule added in the middle of other work.

## What's covered

| File | Loaded | Words, imports included (aim / limit) |
|---|---|---|
| The global instructions: `~/.claude/CLAUDE.md` and the files the config's `global_instructions` lists. Files they `@import` are followed and counted. Blocks between marker lines that a tool's installer added are changed only through that tool, not by hand | Whole, by every session | 4,000 / 5,000 |
| A project's `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`. Claude Code also loads the ones in every folder above the working folder, and a subfolder's when a session reads files in it | Whole, by every session in that project | 1,000 / 3,000 |
| A README sessions are told to follow: a project README its `CLAUDE.md` or a brief says to read first, or a tool README with a section written for Claude to follow when installing or setting the tool up | When a session is told to read it | No budget |

The budgets are a starting point, not a measured law: the user can change them with the config's `budgets` key (`global_words` and `project_words`, each [aim, limit]). Over the aim, move material that only some work needs into a skill or reference file. Over the limit, an edit that adds lines also moves or cuts at least as many. Words are the measure because every one is read by every session; a 5,000-word global file is roughly 6,700 tokens in every conversation before the user has typed anything.

## Where a rule goes

house-style.md's One home per rule table decides it. Three cases come up most with these files:

- **CLAUDE.md or README.** `CLAUDE.md` holds what sessions must do or avoid. The README explains what the project or tool is and how to set it up, for people and sessions alike. A rule a session must follow every time goes in `CLAUDE.md`; when the README also needs it, the README links to it rather than restating it.
- **A global section only one kind of work needs** (one framework, one tool, one repo) costs every other session. It belongs in that work's skill, with a one-line pointer left in the global instructions ("For any work on the billing service, load the `billing-guidelines` skill first"). Moving one changes what sessions see without loading the skill, so it's the user's decision.
- **A rule for one project** never goes in the global instructions, however general it sounds.
- **A rule for one part of a project** (one folder, one file type) can go in `.claude/rules/<name>.md` with `paths:` globs in its frontmatter: Claude Code loads it only when a session works on matching files, so the rest of the project's sessions don't pay for it.
- **Only what a session can't work out itself.** A `CLAUDE.md` line earns its place when it holds what the code and repo don't show: the commands that check work, places where the code misleads, decisions made outside the repo, and anything a session has had to be corrected on twice. A tour of the folders or a summary of the code is read by every session and goes stale at the next rename.
- **A rule that must hold every time** with no exceptions goes in a hook or a permission rule, with at most a pointer here. Claude Code treats these files as guidance a session may decide doesn't apply.

## Layout and wording

- **Sections are `##` headings named for the behaviour** ("Ask before deleting files", "Commit messages"). Keep the names stable: other files, the user and the tests refer to them, and a section's tests live in `evals/<section name as a slug>/` beside the file. When you rename a section, grep the user's skill folders and instruction files for the old name and rename its `evals/` folder.
- **Rules, reasons and wording** work as house-style.md's Rules and reasons and Wording sections describe for skills: every rule carries a short reason and is concrete enough to check, a changed rule is changed in place, never contradicted by a second one, and emphasis stays plain.
- **Hard limits first.** A project `CLAUDE.md` opens with what must never happen there (for example "Hard constraints": files that can't move, a migration that can't be rerun, saves that destroy data), then how to work in it.
- **Write for a session reading cold.** Concrete nouns and the project's own names for things. When a boundary is subtle, one example from the user's work settles it faster than a longer rule.
- **Point, don't restate.** A rule from the global instructions or a skill appears in a project file only as a one-line pointer to its home.

## Any change

Use this for every change to an instruction file, even a one-line rule added while doing something else.

1. **Read the whole file first**, and anything it imports. Run `check_instructions.py <file>` to see where it stands. In a project git doesn't track, the script can't show the change against the last commit, so note the word count before you edit.
2. **Look for a rule that already covers the change** in the global instructions, the project's `CLAUDE.md` and the skills (`grep -ril "<key words>"` over the config's `skill_folders` and `global_instructions` files, and the project). If one exists, edit it rather than adding a second. If the change contradicts a rule elsewhere, raise it with the user instead of letting both stand.
3. **Pick the one home** (above). When that turns out to be a skill, follow SKILL.md's Any change instead.
4. **Write it to the layout above**, in the section it belongs to, with its reason.
5. **Run `check_instructions.py <file>` again.** No new `ERROR`, and fix any path or skill-name `WARN` the edit introduced. The size line shows the words added or removed; over the limit, cut or move in the same edit.
6. **Rerun the tests of every changed section that has them.** The check names them ("has tests in evals/<slug>/"). These tests start real sessions, so first ask how to run them, as [test-tiers.md](test-tiers.md) describes for a section's tests: use the options and costs in that folder's README, or "Run it (about N sessions) / Skip testing" when it gives none. Then run them as the README says. The change counts as done only when it scores at least as well as the README's latest result; record the new result there. When a section that sets how sessions make a choice the user would notice (when to ask, how to name things, what to confirm) is written or largely rewritten and has no tests, propose building a set in the report rather than building it unasked: each set costs real usage to run.
7. **Report** in the reply: what changed and where, the words added and removed, the tests rerun with their scores (or that the user skipped them), and whatever uncommitted-changes reminder the user's instructions require for that file's repo. A project's own repo follows that project's rules for checking in.

## Auditing

See [audit.md](audit.md), Instruction files.
