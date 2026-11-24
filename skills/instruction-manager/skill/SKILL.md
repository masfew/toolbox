---
name: instruction-manager
description: "Creates, changes and audits the user's own skills and the instruction files their sessions follow: the global instructions, project CLAUDE.md files and READMEs sessions are told to follow. Use it whenever the user asks to make a skill, add, change or remove a rule in one of them, tidy, trim, split or audit any of them, or fix when a skill loads, even a one-line edit made during other work. Not for using a skill to do its own job, plugin or Anthropic-provided skills, Claude's memory, settings, hooks and permissions (update-config), committing, or general questions about how skills work (skill-creator)."
---

# Instruction manager

Runs every create, change and audit of the user's skills and instruction files through the same few steps, measuring size, copies and test scores each time, so the drift that many small edits add up to shows in numbers.

It covers the skills in the config's `skill_folders` (and each project's `.claude/skills/<name>/` unless `project_skills` is off), and the instruction files: the global instructions (`~/.claude/CLAUDE.md` plus the config's `global_instructions`), every project's `CLAUDE.md`, and READMEs sessions are told to follow. Plugin and Anthropic-provided skills aren't the user's to edit; Claude's memory, output styles and settings have their own owners. skill-creator's test formats are used here, but these steps win over its own.

`<skill folder>` is the folder this file is in. Run the scripts as `python -I <skill folder>/scripts/<script>`; `check_skill.py --show-config` prints the user's config in effect ([references/config.md](references/config.md) has its keys).

## What to do for each request

| The user asks to | Read | Then |
|---|---|---|
| Make a new skill | [references/house-style.md](references/house-style.md) | [New skill](#new-skill) |
| Change an existing skill: a rule, a typo, the description, moving material | house-style.md for a new section, a description change or material moving between files; nothing more for an edit to one rule | [Any change](#any-change) |
| Add, change or remove anything in the global instructions, a `CLAUDE.md` or a README sessions follow | [references/instruction-files.md](references/instruction-files.md) | Its Any change |
| Audit, review, tidy or trim one skill, all of them, or an instruction file | [references/audit.md](references/audit.md) and house-style.md | audit.md's steps |

## Tests that start sessions

Trigger tests, behaviour tests and an instruction section's tests start real Claude sessions that count against the user's plan limits, and the skill can't see which plan they have. So before the first such run of each task, ask how to run it (Quick, Standard, Full or Skip testing), with the numbers `run_triggers.py <folder> --dry-run` prints, as [references/test-tiers.md](references/test-tiers.md) says. Never carry an answer over to a later task. The user's own `CLAUDE.md` can set a standing answer. The free checks (`check_skill.py`, `check_instructions.py`) never need asking.

## New skill

1. **Check nothing covers it already.** `check_skill.py --all` lists every skill, and the session's skill list has the rest. If one covers most of the request, extend it through [Any change](#any-change) instead.
2. **Pick the home** from the config in effect: the first `new_skill_homes` entry whose `when` fits (ask when two fit). Check the name is free among installed skills, plugin skills included.
3. **Ask what the request leaves open, and wait for the answers before drafting:** what it does, whether it loads only on set words or a slash command, the phrasings that should load it, what shouldn't and which neighbour those belong to, and whether output quality matters enough for behaviour tests. The description and near-misses come from these answers.
4. **Draft it to the house style**, with about 10 should-load prompts and 10 near-misses in `evals/triggers.json` (house-style.md, Tests), and run `check_skill.py` on it until it prints no `ERROR`.
5. **Ask how to test, then tune the description** with [references/tuning.md](references/tuning.md) until it passes, and `--save` the score. On Full, also write `evals/evals.json` (2 to 4 behaviour tests), run each in a subagent with the skill and in one without, drop checks that pass both ways, and fix the skill where it fails.
6. **Install it** the way its home's README says. A new skill appears only in sessions started afterwards.

## Any change

For every change to an existing skill, even a one-line rule added in the middle of other work.

1. **Read what the change touches**: `SKILL.md`, the reference files it affects and the Files table. Run `check_skill.py <folder>` for the starting numbers.
2. **Respect a home project.** If the skill's Improving section names one and you're not in it, suggest the change and why, and edit only when the user says to.
3. **Look for a rule that already covers it** (`grep -ri` over the config's skill folders and global instruction files). Edit that rule rather than adding a second; raise a contradiction with the user rather than letting both stand.
4. **Put it in its one home** (house-style.md, One home per rule) with a short reason, then rerun `check_skill.py`: no new `ERROR`, and over the aim, move or cut something in the same edit.
5. **Only if the description changed:** make sure there's a saved score of the tier you'll use (with no `evals/triggers.json`, write one first; with no saved run of that tier, run the old description with `--description "<old text>"` first). Ask how to test, then run `run_triggers.py <folder> --tier <chosen> --compare --save`. A lower score blocks the edit until it's explained or fixed ([references/tuning.md](references/tuning.md)).
6. **Only if a rule with a behaviour test changed:** on Full, rerun the test in `evals/evals.json` that covers it (the same question as step 5).

The reply gives the words added or removed, the score if a test ran or that the user skipped it, and the uncommitted-changes reminder the user's instructions require for that repo.

## Files

| File | Read when |
|---|---|
| [references/house-style.md](references/house-style.md) | Writing or judging a skill: folder layout, description, `SKILL.md` layout, size, wording, one home per rule, tests |
| [references/instruction-files.md](references/instruction-files.md) | Changing or auditing the global instructions, a `CLAUDE.md` or a README sessions follow |
| [references/audit.md](references/audit.md) | Auditing or tidying skills or instruction files |
| [references/test-tiers.md](references/test-tiers.md) | Before any test that starts sessions: the question and what each option costs |
| [references/tuning.md](references/tuning.md) | Writing or fixing a description against its trigger tests |
| [references/config.md](references/config.md) | Setting up or reading the user's config, or the edit guard's reminder |
| [scripts/check_skill.py](scripts/check_skill.py) | Every create, change or audit of a skill (`--all` for every skill); read only to change a check. The scripts read the config through `scripts/im_config.py` |
| [scripts/check_instructions.py](scripts/check_instructions.py) | Every change or audit of an instruction file (`--all` for all of them) |
| [scripts/run_triggers.py](scripts/run_triggers.py) | Trigger tests: `--dry-run` for the question's numbers, then `--tier`, `--compare`, `--save`, and `--description "<candidate>"` to try one without editing |
| [evals/run_behaviour.py](evals/run_behaviour.py) | Changing this skill's steps: runs the behaviour tests in `evals/evals.json` |

## Improving this skill

A lesson that holds for every skill (a check the script should make, a step that misled a session, a number that proved wrong) is suggested to the user with its evidence and goes in once they agree: rules in house-style.md, checks in a script with a case in the tool folder's `tests/`. A lesson about one skill goes in that skill. After changing a script, run `python tests/test_check_skill.py` and `python tests/test_edit_guard.py` from the tool folder.
