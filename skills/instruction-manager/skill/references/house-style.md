# House style

The rules every one of the user's skills follows. They come from what skills that load reliably and stay short have in common, and from the faults that made others drift. The check script measures the numbers here; the rest is read by eye. The word and character budgets are a starting point: the user can change them with the config's `budgets` key (see SKILL.md, Configuration).

## Where a skill lives

The config's `new_skill_homes` says where a new skill goes: a list of `{"when": ..., "path": ...}` entries, tried in order, where `path` is a folder pattern with `<name>` in it. Take the first entry whose `when` fits what the skill is about; when two fit, ask the user. With no config the home is `~/.claude/skills/<name>`. A home's own README says how skills there are registered (an install script, a row in a table, a link); follow it, because a skill that isn't registered the way its home expects may never reach a session.

Name rules:

- Lowercase words joined by hyphens, matching the folder name.
- A prefix that groups related skills (`web-`, `docs-`) is the user's choice. List the prefixes in the config's `skill_prefixes`, so the check script can tell a backticked skill name in an instruction file from other code words and report a renamed or removed skill.
- Never reuse the name of an installed plugin or Anthropic-provided skill. Two skills with one name leave the session to guess which one loads.

## Frontmatter

- `name` matches the folder name: lowercase words joined by hyphens.
- `description` is one line. If it contains `: ` or ` #`, wrap the whole value in double quotes. Unquoted, YAML stops reading at the colon, so sessions see only the text before it as the description, and the skill may load only when something else names it.
- Run skill-creator's `quick_validate.py` (the check script does) after any frontmatter change.

## Description

The description has one job: make the skill load when it should and not when it shouldn't. It's the only part of a skill every session reads, and all descriptions together sit in every session's context, so a word that doesn't change what loads is paid for in every session for nothing. How the skill works belongs in the body.

**First decide which kind of skill it is**, since the two need different descriptions:

- **Phrase-triggered:** it loads on words the user says or a slash command, and on nothing else. The description names the words and says it never loads otherwise: "Load only when the user says "ship it" as an instruction, or types /ship. Never load it otherwise, even for a request to build and deploy in one go." Nothing more: what the skill does doesn't help a session spot two words.
- **Situation-triggered:** it loads on what the task is about. Use these parts, in this order, and only the ones the trigger tests need:
  1. **The job, in a few words**, from the user's side: "How to write release notes for the docs site", "Checks a recipe's units and scales servings". Name the job, not its steps.
  2. **"Use it whenever…"** with the situations and the words the user actually uses ("asks why the build is slow, hangs, stalls"), not abstract categories.
  3. **"even if the user doesn't say X"**, naming the word they'd most likely leave out.
  4. **"Not for… (`other-skill`)"** for a neighbouring skill that claims the same prompts, in the trigger tests or plainly. Pairs that overlap are the usual cause of a skill that loads when it shouldn't, or not at all. Don't list neighbours that don't collide.
  5. **A precedence line** ("overrides the plugin's `deploy-*` skills where they conflict") only when the skill must win over another one.

**Every clause earns its place.** Each clause either makes the skill load for a should-load prompt in `evals/triggers.json` that it otherwise misses, or stops it loading for a near-miss there. A clause you can't point to such a prompt for is cut; [Tuning a description](../SKILL.md#tuning-a-description) ends with a pass that tests each cut.

**Never an inventory.** A list of what the skill does or holds (its steps, tools, outputs, file formats or sections) costs tokens in every session and helps no prompt load. It's the easiest mistake to make, because it reads like a good summary. "Deploys the site: builds it, runs the tests, uploads to the CDN, purges the cache and posts in the team channel" is an inventory; "How to deploy the docs site" names the job, and the steps go in the body.

**Length:** as short as passes the trigger tests. There's no minimum. A situation-triggered skill often needs a few hundred characters to cover its situations and neighbours, and that's fine when each clause passes the test above; over 900 characters is worth a second look. Never over 1,024, which skill-creator's validator rejects.

## SKILL.md layout

In this order, leaving out what a skill doesn't need:

1. **Title** (`# Release notes`).
2. **Purpose**, in one short paragraph: what the skill is for and, when it helps, what it's trying to save ("The aim is speed: get the page right in as few rounds as possible"). Audits measure drift against this paragraph, so keep it true.
3. **Where neighbouring rules live**: the skills and project files to read alongside it, by name and section ("the site-wide rules live in `docs-guidelines`"). Point to them; don't restate them.
4. **The workflow**, as numbered steps.
5. **Habits or traps** that save rounds: each a bold one-sentence claim, then what to do instead.
6. **Files**: a table of reference files with a "Read when" column.
7. **Improving this skill** (below).

## Size

Count words, not lines. Lines don't measure what a skill costs: an 80-line skill with long paragraphs can hold more words than a 140-line one made of short lines.

| File | Aim | Limit |
|---|---|---|
| `SKILL.md` body (loaded every time the skill is used) | 2,000 words | 3,000 words |
| Each reference file (loaded only when its "Read when" fits) | one topic; over 1,500 words, start it with a list of its sections | 3,000 words, a warning rather than a hard limit: split it when its parts are read at different times |

The config's `budgets` key overrides these (`skill_body_words` and `reference_words`) and the description lengths (`description_chars`: a minimum, `0` for none, then the second-look length and the limit).

Over the aim, move material that's only needed sometimes (long checklists, worked examples, trap catalogues) into a reference file. Over the limit, an edit that adds lines also moves or cuts at least as many. Estimate tokens as words × 1.35.

Reference files are where most of the words end up: a style guide can run to several thousand words. They only cost tokens when a task reads them, so they get a warning, not an error, but a guide read whole for every task in its area costs as much as a `SKILL.md` that size.

## Rules and reasons

- **Every rule carries a short reason**, so a later session can tell whether it still applies: "The service rate-limits uploads to 10 a minute, so batch them…". A rule without a reason gets kept after it stops being true, or dropped without anyone knowing what it protected.
- **Dates and evidence only when they're the reason.** "measured over ~120 transitions" or "verified live 2026-10-08" say how sure a rule is and stay. Trial narratives, round-by-round history and who decided what on which day go in the skill's plan or README, not in `SKILL.md`, which pays for them on every load.
- **When a rule changes, change it in place.** Don't add a second rule that contradicts or refines the first. A trap list that says "fix or remove the entry rather than adding a contradicting one" is the model.

## One home per rule

Each rule lives in exactly one place, and everything else links to it:

| Rule applies to | Its home |
|---|---|
| Every session, every project | The global instructions |
| Every project of one kind (one framework, one language, one tool) | A guidelines skill for that kind of project |
| One kind of task | The skill for that task |
| One project | That project's `CLAUDE.md` or README, never a skill |

Don't restate a rule from a higher row. If three skills each end with "remind the user to commit and push", and the global instructions already require it, the three copies drift apart and a change has to be made four times. A one-line pointer with the rule's home and section is fine ("nothing is deployed until the user approves it (`web-guidelines`, Deploying)").

## Links and paths

- Link reference files relative to `SKILL.md`, as `references/<file>.md`. A bare `[traps.md](traps.md)` points at a file that isn't there.
- A pattern such as `styles/<style>.md` counts as linking every file it matches.
- Never hard-code a path that changes per session, such as another skill's synced copy; find it each time.
- A folder kept on purpose but never read in normal use (a `history/` folder of old results) says so in `SKILL.md`, so the check script and later sessions don't treat it as clutter.

## Improving this skill

Every skill ends with a short section saying how it grows, because sessions add to skills after almost every round and this is where drift starts:

- **A skill with a home project** (for example a `ui-design` skill and the sandbox project built to develop it) names it. In the home project, general lessons go into the skill or its references. Everywhere else the skill is read-only: suggest the addition and why, and edit only when the user explicitly says to. A finding being useful isn't permission.
- **A skill without one** says where new material goes (which reference file, the style guide) and what doesn't belong in it.
- Every change, in any project, goes through instruction-manager's revision workflow.

## Tests

Tests live inside the skill folder, in `evals/`, so they move with the skill and any session can rerun them. Claude only reads that folder when a step tells it to. Every run that starts sessions follows the question in [test-tiers.md](test-tiers.md).

| File | What it holds | Who has one |
|---|---|---|
| `evals/triggers.json` | About 10 prompts that should load the skill and 10 near-misses that shouldn't, as `[{"query": "...", "should_trigger": true}, ...]`, the format skill-creator's `run_eval.py` and `run_loop.py` read | Every skill |
| `evals.json` | 2 to 4 behaviour tests with checks, in skill-creator's `evals.json` schema (its schemas reference file) | Only skills whose output quality matters |
| `last-run.json` | The latest trigger run at the top level (date, a hash of the description it tested, `tier`, `model`, runs per query, `seconds`, passed and total, and the queries that failed) and the latest run of each tier under `tiers` | Every skill with `triggers.json` |

Writing `triggers.json`:

- Write prompts the way the user types them: casual, with real project names and context, typos and all. Test sessions run in an empty folder, not in a project, so a should-load prompt for a skill about one tool or framework names it somewhere ("in my docs site", "the deploy-checklist skill"); "the footer links are wrong" alone can't tell a session which project it's about. Every prompt carries its own context.
- Take the near-misses from the neighbouring skills' territory (the prompts that should load the neighbour instead), plus requests that share the skill's words but not its job. Those are what catch two skills claiming the same prompt.
- A drop in the score after a description change blocks the edit until it's explained or fixed. Scores are only compared within the same tier, because a Quick run on a small model and a Full run on a large one aren't the same measurement.
