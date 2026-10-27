---
name: instruction-manager
description: "How to create, change and audit the instructions the user's Claude Code sessions follow: their own skills, the global instructions, each project's CLAUDE.md, and READMEs sessions are told to follow. Use it whenever the user asks to make a skill; add, change or remove a rule in a skill, the global instructions or a CLAUDE.md; tidy, trim, reorganise or audit any of them; or fix when a skill loads, even if they don't say instruction-manager or it's a one-line edit made during other work. Not for using a skill to do its own job, plugin or Anthropic-provided skills, Claude's memory, settings, hooks and permissions (update-config), committing, or general questions about how skills work (skill-creator)."
---

# Instruction manager

The user's skills and instruction files are edited by many sessions over months. Each small addition looks reasonable on its own, and together they bloat a file, copy rules between files, contradict earlier rules and change when a skill loads without anyone noticing. This skill makes every create, change and audit go through the same steps, with size, copies and test results measured each time, so drift shows up in numbers.

It covers two kinds of the user's own files:

- **Skills:** every skill folder the config's `skill_folders` matches (default `~/.claude/skills/*`) and, unless `project_skills` is off, each project's `.claude/skills/<name>/`. Skills that come from a plugin or from Anthropic aren't the user's to edit. skill-creator's test formats are used here, but this skill's steps win over skill-creator's own.
- **Instruction files:** the global instructions (`~/.claude/CLAUDE.md` plus the files the config's `global_instructions` lists), every project's `CLAUDE.md`, and READMEs that sessions are told to read and follow. Claude's auto-memory, output styles and `settings.json` aren't covered: memory has the harness's own rules, and settings belong to `update-config`.

Read [references/house-style.md](references/house-style.md) before writing or judging any skill: where skills live, the description's shape and length, word budgets, one home per rule, links and the test files. For an instruction file, read [references/instruction-files.md](references/instruction-files.md) instead.

## Which workflow

| The user asks to | Follow |
|---|---|
| Make a new skill | [New skill](#new-skill) |
| Change anything in an existing skill, however small (a rule, a typo, a description, moving material) | [Any change](#any-change) |
| Add, change or remove anything in the global instructions, a project's `CLAUDE.md` or a README sessions follow, however small | [references/instruction-files.md](references/instruction-files.md) |
| Audit, review, tidy or trim one skill, all of them, or an instruction file | [references/audit.md](references/audit.md) |

## Before any test that starts sessions, ask how to run it

Trigger tests, behaviour tests and an instruction section's tests start real Claude sessions that count against the user's plan usage limits, which differ a lot between plans. So **every time, before the first such run, ask the user how to run it** (Quick, Standard, Full or Skip testing), with the question, wording and numbers in [references/test-tiers.md](references/test-tiers.md). Never start them without an answer, and never carry one answer over to a later task. The user's own `CLAUDE.md` can say otherwise (for example "always run Standard"); then follow it. The free checks never need asking.

## The scripts

All three are Python standard library only and live in this skill's `scripts/` folder. Run them with `python -I <this skill's folder>/scripts/<script> …`.

- **`check_instructions.py <file>`** (or `--all` for the global instructions and every project `CLAUDE.md` sessions have run in): word count with imports against the budget and the change against the last git commit, broken imports, links and paths, skill names that aren't installed, sentences copied from a skill or the global instructions, and which tested sections need their tests rerun.
- **`check_skill.py <skill folder>`** (or `--all` for every skill the config covers): frontmatter (including skill-creator's `quick_validate.py`), description length, word counts with estimated tokens and the change against the last git commit, broken and never-linked files, sentences that closely copy another skill or the global instructions, and whether the trigger tests are present and current. `ERROR` breaks the skill or a hard limit; `WARN` is over an aim or likely wrong. `--show-config` prints the effective config.
- **`run_triggers.py <skill folder>`**: runs `evals/triggers.json` against the description (or `--description "<candidate>"`) and prints the score and each failed prompt with what loaded instead. Pick the cost with `--tier quick|standard|full` (what each means: [references/test-tiers.md](references/test-tiers.md)); `--runs` and `--model` without a tier make a custom run. `--dry-run` prints each tier's session count, model and time estimate and starts nothing; with no tier, `--runs` or `--model` the script does the same and exits 2, so it never starts sessions by accident. `--compare` checks against the latest saved run of the same tier and exits 3 if the score dropped (with no earlier run of that tier it says so and passes); `--save` records the score in `last-run.json` beside the triggers (with `--compare`, only when it didn't drop). Test sessions run in an empty folder with user-level settings off, so prompts must carry their own context (house-style.md, Tests). If the script can't find the CLI or the CLI isn't signed in, tell the user to run the CLI once in a terminal and use `/login`.

The **edit guard** (a hook the installer adds) never blocks an edit. When a session edits a file in a covered skill folder, a `CLAUDE.md`, or a file the global instructions import, without having loaded this skill, it tells the session to load this skill. It doesn't see edits made through shell commands.

### Configuration

`~/.claude/instruction-manager.json` (or the file `INSTRUCTION_MANAGER_CONFIG` names) holds the user's setup; read it with `check_skill.py --show-config`. Every key is optional; a missing file means the defaults.

| Key | What it does | Default |
|---|---|---|
| `skill_folders` | Glob patterns (`~`, `*` one level, `**` any depth) for the user's skills; a match needs a `SKILL.md`. Used by `--all`, the duplicate search and the edit guard | `["~/.claude/skills/*"]` |
| `project_skills` | Also treat each project's `.claude/skills/<name>/` as the user's skills | `true` |
| `global_instructions` | Files checked as global instructions (`~/.claude/CLAUDE.md` always counts; their `@import`s are followed, and the edit guard watches the imported files too) | `["~/.claude/CLAUDE.md"]` |
| `skill_prefixes` | Name prefixes (such as `web-`) that mark a backticked word in an instruction file as a skill name | `[]` |
| `new_skill_homes` | Where a new skill goes: `{"when": "what it's about", "path": "folder pattern with <name>"}` entries, tried in order | `~/.claude/skills/<name>` |
| `budgets` | Overrides for the budgets in house-style.md and instruction-files.md | those tables |

## New skill

1. **Check nothing already covers it.** List every skill's name and description (`check_skill.py --all`, and the session's skill list for the rest). If one covers the request or most of it, offer to extend it through [Any change](#any-change) instead. 
2. **Pick the home** from the config's `new_skill_homes`: the first entry whose `when` fits the skill. If two fit, ask. Check the name is free among installed skills too, since a plugin skill can hold it.
3. **Interview the user, and wait for the answers before drafting anything**, in one round where you can: what it does, whether it loads only on set words or a slash command (house-style.md, Description), the situations and phrasings that should load it, what should not and which neighbouring skill those belong to, and whether output quality matters enough for behaviour tests. The description and near-misses come from those answers, so don't guess them.
4. **Draft it to the house style** (house-style.md, SKILL.md layout). Keep `SKILL.md` near 2,000 words; put material only some tasks need in reference files.
5. **Write `evals/triggers.json`**: about 10 should-load prompts and 10 near-misses, as house-style.md's Tests section describes. Take near-misses from the neighbours named in step 3.
6. **Run `check_skill.py`** on it and fix every `ERROR`. The checks are free, and the test question in the next step says they passed.
7. **Ask how to test, then tune the description** ([below](#tuning-a-description)) until it passes, and `--save` the score. The one question covers this step and the next.
8. **Behaviour tests**, only when output quality matters and the chosen tier is Full: write `evals/evals.json` (2 to 4 prompts with checkable expectations, skill-creator's schema), run each in a subagent told to follow the new skill, grade the output, and fix the skill where it fails. On a smaller tier, say in the report that they weren't run.
9. **Install and register it** the way the chosen home's own README says (an install script, a row in a table, a link). A skill in `~/.claude/skills/<name>` needs nothing more. A new skill only appears in sessions started after it's installed.
10. **Report**: what it does, its word count and description length, the trigger score and tier, and whatever uncommitted-changes reminder the user's instructions require for that repo.

## Any change

Use this for every change to an existing skill, even a one-line rule added in the middle of other work.

1. **Read the whole skill first**: `SKILL.md`, the reference files the change touches (and the Files table, so you know what the others hold), and `evals/`. Run `check_skill.py <folder>` to see where it stands before you edit.
2. **Respect a home project.** If the skill's Improving This Skill section limits edits outside a home project, and you're not in it, suggest the change and why, and edit only when the user explicitly says to.
3. **Look for a rule that already covers the change**, in this skill, its references, the neighbouring skills, the global instructions and the project's `CLAUDE.md` (`grep -ri` for the key words, over the config's skill folders and global instruction files). If one exists, edit that rule rather than adding a second one. If the change contradicts a rule elsewhere, raise it with the user instead of letting both stand.
4. **Put the change in its one home** (house-style.md, One home per rule), with a short reason. A rule for one project goes in that project's `CLAUDE.md`, not a skill.
5. **Run `check_skill.py <folder>`.** No new `ERROR`. Its size lines show the words added or removed against the last commit. When the change pushes `SKILL.md` over its aim, move or cut something in the same edit.
6. **If the description changed**, make sure there's a score to compare against: with no `evals/triggers.json`, write one first (New skill step 5), and with no saved run of the tier you'll use, run the old description first (`--description "<old text>"`, then `--save` after restoring it, or run before editing). Ask how to run the tests (above), then `run_triggers.py <folder> --tier <chosen> --compare --save`, which saves the new score only when it isn't lower. A lower score blocks the edit until it's explained or fixed. If the user skips testing, say so in the report; `check_skill.py` keeps warning that the description changed since its last trigger run.
7. **If a behaviour rule changed** and the skill has `evals/evals.json`, the Full tier reruns the test that covers it (New skill step 8). It's part of the same question as step 6.
8. **Report** in the reply: what changed and where, the words added and removed, the trigger score and tier if it ran, and whatever uncommitted-changes reminder the user's instructions require for that repo.

## Tuning a description

Ask how to test once, before the first run of the task. The answer covers every candidate below.

1. Run the prompts against the current description. Each failed prompt shows what loaded instead.
2. For each failure, work out the situation the description doesn't cover, or the neighbour it collides with. Write two or three candidate descriptions that cover the situation in general words, in house-style order. Never paste a test prompt's own wording into the description: it passes the test and generalises to nothing.
3. Run each candidate with `--description "…"`, then the best one or two with the chosen tier. With Quick, every run is `--tier quick`; with Standard or Full, draft runs use `--runs 1` on the default model and only the finalists use the chosen tier. Prefer the higher score; on a tie, the shorter description, since every session pays for it.
4. If a near-miss belongs to a neighbouring skill and keeps loading this one, sharpen the "Not for…" clause naming that neighbour, and check the neighbour's description doesn't claim the prompt too.
5. When the winner only passes after several rounds, add four fresh prompts (two each way) that weren't used while tuning, and check it on those before trusting it. Add them to `triggers.json` afterwards.
6. **Trim the winner**, since nothing else shortens a passing description: cut the clause least likely to earn its place (house-style.md, Description), run it as step 3 runs a draft, and keep the cut if the score holds. Stop at the first cut that lowers it, or after three.
7. Write the winner into `SKILL.md` and `--save` its score.

## Files

| File | Read when |
|---|---|
| [references/house-style.md](references/house-style.md) | Writing, judging or changing any skill |
| [references/instruction-files.md](references/instruction-files.md) | Changing the global instructions, a `CLAUDE.md` or a README sessions follow |
| [references/audit.md](references/audit.md) | Auditing or tidying one skill, all skills or instruction files |
| [references/test-tiers.md](references/test-tiers.md) | About to run any test that starts sessions: the question to ask and what each option costs |

## Improving this skill

This skill and its house style change only through its own [Any change](#any-change) workflow, run on itself. When a create, change or audit teaches something general (a check the script should make, a step that misled a session, a number that proved wrong), suggest the change with the evidence and edit once the user agrees. A lesson about one skill goes in that skill.
