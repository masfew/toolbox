# House style

The rules every one of the user's skills follows, taken from what skills that load reliably and stay short have in common. The check script measures the numbers; the rest is read by eye. The budgets are a starting point the config's `budgets` key can change ([config.md](config.md)).

## Names and registration

- Lowercase words joined by hyphens, matching the folder name. A prefix that groups related skills (`web-`, `docs-`) is the user's choice; list it in the config's `skill_prefixes` so the check script can spot renamed or removed skills named in instruction files.
- Never reuse the name of an installed plugin or Anthropic-provided skill: with two skills of one name, the session guesses which loads.
- Register a new skill the way its home's README says (an install script, a row in a table, a link), or it may never reach a session.

## Frontmatter

- `name` matches the folder name.
- `description` is one line. If it contains `: ` or ` #`, wrap the whole value in double quotes: unquoted, YAML stops at the colon and sessions see only the text before it.
- The check script runs skill-creator's `quick_validate.py` after hiding the Claude Code keys it doesn't know (`disable-model-invocation`, `argument-hint`, `model`, `user-invocable` and the rest).

## Folder layout

`SKILL.md` is the only file at the top of the skill folder; everything else goes in a subfolder named for how a session uses it:

| Folder | Holds | A session |
|---|---|---|
| `references/` | Instructions only some tasks need | Reads one when the Files table or a step says so |
| `scripts/` | Code the steps run | Runs it; reads it only to change it |
| `assets/` | Templates and files the skill copies, fills in or publishes (a page template, a stylesheet) | Copies or passes them on; never reads them to follow |
| `evals/` | Trigger and behaviour tests, their last results and their runners | Only when testing |

Scripts find their assets as their own folder's sibling (`Path(__file__).parent.parent / "assets"`), so the skill works from any install path. A tool's README, installer and its own tests sit beside the skill folder, not in it. The check script warns about any other file beside `SKILL.md`.

## Description

The description has one job: make the skill load when it should and not when it shouldn't. All descriptions sit in every session's context, so a word that doesn't change what loads is paid for everywhere; how the skill works belongs in the body. Claude Code also cuts each description at 1,536 characters and, once all of them pass about 1% of the context window, drops the least-used skills' descriptions, so put the trigger first.

**First decide which kind of skill it is:**

- **Phrase-triggered:** it loads on words the user says or a slash command, and on nothing else. The description names the words and says it never loads otherwise: "Load only when the user says "ship it" as an instruction, or types /ship. Never load it otherwise." A skill that should run only from its slash command sets `disable-model-invocation: true` instead: Claude Code leaves its description out of every session and never starts it on its own, which suits a workflow whose timing the user picks (a deploy, a release). Its description becomes a one-line note for the `/` menu, with no trigger tests.
- **Situation-triggered:** it loads on what the task is about. Use these parts, in this order, and only the ones the trigger tests need:
  1. **The job, in a few words**, from the user's side: "Checks a recipe's units and scales servings". Name the job, not its steps.
  2. **"Use it whenever…"** with the situations and the words the user actually uses ("asks why the build is slow, hangs, stalls"). Write each listed situation as something done to the skill's own object ("mark step statuses on an existing plan"), not a bare noun ("outcomes, a snapshot"): a bare noun reads as a trigger of its own, and a near-miss that shares it loads the skill.
  3. **"even if the user doesn't say X"**, naming the word they'd most likely leave out.
  4. **"Not for… (`other-skill`)"** for a neighbouring skill that claims the same prompts. Overlapping pairs are the usual cause of a skill loading when it shouldn't, or not at all; don't list neighbours that don't collide.
  5. **A precedence line** ("overrides the plugin's `deploy-*` skills where they conflict") only when the skill must win over another one.
  6. **A load note** ("If ArtifactData is deferred, load it with ToolSearch in the same message as this skill") only when the first step needs a deferred tool, since loading it in a message of its own costs a round trip.

better-plans' description, in this repo, has this shape and passes 22 of 22 trigger prompts.

**Every clause earns its place:** it makes the skill load for a should-load prompt in `evals/triggers.json` that it otherwise misses, or stops it loading for a near-miss there. A clause with no such prompt is cut; [tuning.md](tuning.md) ends with a pass that tests each cut.

**Never an inventory.** A list of what the skill does or holds (steps, tools, outputs, sections) helps no prompt load, and a session may follow the summary instead of reading the body. "Deploys the site: builds it, runs the tests, uploads to the CDN and posts in the team channel" is an inventory; "How to deploy the docs site" names the job.

**Length:** as short as passes the trigger tests. A few hundred characters is normal for a situation-triggered skill; over 900 is worth a second look, and over 1,024 fails skill-creator's validator.

## SKILL.md layout

In this order, leaving out what a skill doesn't need. better-plans, in this repo, is a worked example.

1. **Title** (`# Release notes`).
2. **Purpose**, in one or two sentences: what the skill does and what it saves ("so a release takes one step instead of a round of back-and-forth"). Audits measure drift against it, so keep it true.
3. **Where neighbouring rules live**: the skills and files whose rules it carries out or defers to, by name and section, and which wins ("each project's `CLAUDE.md`, whose own release rules win"). Point to them; don't restate them.
4. **Conventions**, in one short paragraph: how to run the skill's commands (which shell, `python -I`, absolute paths), placeholders (`<skill folder>`, `<scratchpad>`), and shorthand for a call or format the steps use more than once ("**List X to D** means one `ArtifactData` `list` per collection, each with `out_dir` D"). Define each once here and use the short form after.
5. **The work**, as numbered steps with a bold lead each; or, when the skill serves several kinds of request, a routing table (the request, the reference file to read, and the first message's calls, so the `Read` rides in that message instead of costing a round trip of its own) followed by a short section per kind. A trap goes in the step where a session meets it; one only a rare case meets goes in a reference file read when that case comes up (such as a "when git stops" file, read when any git command fails).
6. **Files**: a table of every file in `references/`, `scripts/`, `assets/` and `evals/` that a session reads, runs or changes, with a "Read when" column. A script's row says when to read it (to change it); otherwise it's run as the steps say.
7. **Improving this skill**, only when the skill has growth rules of its own (below).

## Size

Count words, not lines: a short file of long paragraphs can hold more than a long file of short lines.

| File | Aim | Limit |
|---|---|---|
| `SKILL.md` body (loaded every time the skill is used) | 2,000 words | 3,000 words |
| Each reference file (loaded only when its "Read when" fits) | one topic; over 100 lines or 1,500 words, start it with a list of its sections, since Claude previews long files by reading only their first lines | 3,000 words, a warning: split it when its parts are read at different times |

After a compaction Claude Code puts back only the first 5,000 tokens of each skill in use (3,000 words is about 4,050), so put what matters most first. Over the aim, move what's only sometimes needed (long checklists, worked examples, one sub-task's traps) into a reference file; over the limit, an edit that adds lines moves or cuts at least as many. Estimate tokens as words × 1.35. A reference file read whole for every task in its area costs as much as a `SKILL.md` that size.

## Rules and reasons

A skill holds the rules and the short reasons a session needs to apply them. The evidence behind a rule lives beside the skill, where sessions never load it.

- **A reason goes in only when a capable newcomer would misapply the rule without it**, and it stays a clause, not a sentence of its own. That's when it:
  - **covers cases the rule doesn't name:** "batch uploads, since the service allows 10 a minute" also covers a retry loop;
  - **shows where the rule stops:** "run the migration only on staging, whose data is disposable" also allows a disposable local copy;
  - **settles which of two rules wins:** "ask before renaming a command, since users type it" says why this choice is asked when the skill otherwise decides.

  An obvious rule (a path, a file format, a step any session takes) needs no reason.
- **Evidence goes in the skill's notes, never in the skill or its reference files.** Where a rule was seen, what was measured, dates, project names and who decided ("in the billing app, 7 of 7 runs stalled") go in a file beside the skill folder: the tool's README, or `notes/<skill>.md` at the root of a repo that holds several skills. File each entry under its rule's heading, and remove it with the rule.
- **Keep the version a fact was last checked on** ("on version 4.2"), or the date when the thing has no version (a live service): a session uses it to judge whether the fact still holds.
- **When a rule changes, change it in place**, never with a second rule that contradicts or refines the first.

## Wording

A skill is read once and stays in context, and the model reading it is capable, so every line should change what a session does:

- **Only what a session would get wrong without it.** If a session would get it right anyway, cut the whole sentence.
- **Instructions concrete enough to check**, worded for the whole task: "Run `npm test` after every edit", not "test your changes".
- **Every step ends on a condition that says it's done** ("until the check prints no `ERROR`").
- **Match firmness to how fragile the step is:** exact commands for steps that break or destroy things, the goal and its limits for steps that need judgement.
- **A default, not a menu.** Name the one way and when to do otherwise.
- **One name for each thing**, used everywhere.
- **Plain emphasis.** State the rule, with its reason when it has one, instead of `MUST` or capitals: current models over-apply a shouted rule. One that must hold every time belongs in a hook.
- **Say it once.** A call or format the steps repeat is defined in Conventions and named after that; a rule the description, the global instructions or a reference file already states isn't repeated in the body.
- **Let the scripts speak.** What a script prints by itself (its warnings, the files it wrote, what to do next) needs no line in the skill. Keep a script's option table only when a step sends the call in the same message as others, where a `--help` call would cost a round trip.
- **Decide from state, don't add questions.** Where the user's rules tell sessions to decide, give the deciding rule ("while every step is Not started, add it to the core plan; after that, as a future idea") instead of "ask when unsure". Questions stay for what only the user can answer: what they'd notice, spending, and anything unsafe.
- **No fixed report shapes.** The user's output style governs replies. A step that ends in a report names only what a session would otherwise leave out (another session's commits that went along, a change left out and why).

## One home per rule

Each rule lives in exactly one place, and everything else links to it:

| Rule applies to | Its home |
|---|---|
| Every session, every project | The global instructions |
| Every project of one kind (one framework, one language, one tool) | A guidelines skill for that kind of project |
| One kind of task | The skill for that task |
| One project | That project's `CLAUDE.md` or README, never a skill |

Don't restate a rule from a higher row: copies drift apart, and a change then has to be made in every one. A one-line pointer with the rule's home and section is fine ("nothing is deployed until the user approves it (`web-guidelines`, Deploying)").

## Links and paths

- Link files relative to the file doing the linking: `SKILL.md` links `references/<file>.md`, `scripts/<file>` and `assets/<file>`; a reference file links its siblings bare (`[making.md](making.md)`).
- Link every reference file from `SKILL.md` itself, with when to read it. A file found only through another reference file may get read only in part.
- A pattern such as `styles/<style>.md` counts as linking every file it matches.
- Never hard-code a path that changes per session, such as another skill's synced copy; find it each time.
- A folder kept on purpose but never read in normal use (a `history/` of old results) says so in `SKILL.md`, so it isn't taken for clutter.

## Improving this skill

How skills grow in general is this skill's job: every change goes through [Any change](../SKILL.md#any-change), and [One home per rule](#one-home-per-rule) says where a new rule goes. So a skill ends with this section only for growth rules of its own:

- **A home project** (a `ui-design` skill and the sandbox built to develop it): name it. Outside it the skill is read-only: suggest the addition and why, and edit only when the user says to.
- **A test every change must pass**, such as a scenario script that needs a case for each changed command.
- **Where new material goes, when One home per rule doesn't settle it**, such as which reference file takes new traps.

A skill with none of these leaves the section out; an older one that only restates the above is trimmed the next time the skill is edited or audited.

## Tests

Tests live in the skill's `evals/` folder, so they move with it. Every run that starts sessions follows the question in [test-tiers.md](test-tiers.md).

| File | What it holds | Who has one |
|---|---|---|
| `evals/triggers.json` | About 10 prompts that should load the skill and 10 near-misses, as `[{"query": "...", "should_trigger": true}, ...]` (skill-creator's format) | Every skill except slash-only ones |
| `evals/evals.json` | 2 to 4 behaviour tests in skill-creator's `evals.json` schema. Run each with the skill and without it (or with the previous version), and drop a check that passes both ways | Only skills whose output quality matters |
| `evals/last-run.json` | The latest trigger run, and the latest of each tier under `tiers` (written by `run_triggers.py --save`) | Every skill with `triggers.json` |

Writing `triggers.json`:

- Write prompts the way the user types them, casual and with real names. Test sessions run in an empty folder, so each prompt carries its own context ("in my docs site", "the deploy-checklist skill").
- Leave out prompts that start with the skill's slash command: `/name` loads the skill without reading the description, so `run_triggers.py` counts it as failed (seen 2026-10-26).
- Take the near-misses from the neighbouring skills' territory, plus requests that share the skill's words but not its job.
- A drop in the score after a description change blocks the edit until it's explained or fixed. Scores compare only within one tier.
