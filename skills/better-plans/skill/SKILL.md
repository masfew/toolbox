---
name: better-plans
description: "Makes, reads and updates the user's plan pages. Use it whenever the user asks for a plan or roadmap by name, a plan-mode plan is approved, a brief says to read the plan, or the user wants something done to an existing plan: mark step statuses or outcomes, add steps or ideas, bring in the future ideas they accepted, rejected or reordered, build the phases they ticked, or save a snapshot of its page. Not for a strategy, proposal or draft page they didn't call a plan (artifact-style). If ArtifactData is deferred, load it with ToolSearch in the same message as this skill."
---

# Better plans

Every plan is an Artifact page built from [assets/template.html](assets/template.html), with [assets/plan.css](assets/plan.css) and [assets/plan.js](assets/plan.js) published beside it, so plans look and work the same from one session to the next. Never restyle one, and skip the design pass: the template already meets the Artifact page contract.

A plan's content lives in the page's database, and the page builds itself from it each time it opens. **Every change is one new record** in the plan's `statuses` collection, written by `plan.py`: no page read, no republish. Numbers (2.3, F7) aren't stored, so the page renumbers itself, and a step number written in text follows its step. A plan whose `plan` collection has no `_plan` document is an older HTML plan, changed by republishing: the flows below check for it.

`<skill folder>` is the folder this file is in and `<scratchpad>` the session's scratchpad. `plan.py` below means `python -I <skill folder>/scripts/plan.py`. Find a plan with the Artifact tool's `list` action if you don't have its URL. **List X to D** below means one `ArtifactData` `list` per named collection, each with `out_dir` D and `query: {"limit": 1000}`.

## What to do for each request

| Request | Read | First message |
|---|---|---|
| Statuses, an Outcome, a note, a rename, a word swap the user spells out, a move or new part where the user says where, a future idea | Nothing more | [Record updates](#record-updates) |
| A change that needs the plan's current text (rewording in your own words, a change that depends on what's there) | Nothing more | [Lookup updates](#lookup-updates) |
| Read a plan to work from it (build a step, answer a question, write a brief) | Nothing more | [Reading a plan for context](#reading-a-plan-for-context) |
| Build the selected (ticked) phases or features, or two or more phases in one session | [references/building.md](references/building.md) | With the `Read`: Artifact `open` of the plan's `url`; list `plan`, `statuses` and `features` to `<scratchpad>/plan/db`; Bash `plan.py build <scratchpad>/plan/db` |
| The user has updated their future ideas (Accept, Reject, edits) | [references/selections.md](references/selections.md) | With the `Read`: list `plan`, `statuses` and `features` to `<scratchpad>/db`; Bash `plan.py outline <scratchpad>/db --jobs` |
| Accept or plan an idea straight away | Nothing more | A record update with a `## Feature:` part ([details](references/selections.md#accepting-or-planning-an-idea-straight-away)) |
| Make a new plan | [references/making.md](references/making.md) | Nothing more: the next message writes the source and publishes |
| Batches, only when asked: a new plan with them, adding them, or building one | [references/batches.md](references/batches.md), plus making.md for a new plan | To build one: [Reading a plan for context](#reading-a-plan-for-context)'s first message, with the `Read` |
| Save a snapshot, or the page looks out of date to someone who can't sign in | [references/snapshots.md](references/snapshots.md) | With the `Read`: list `plan` and `statuses` to `<scratchpad>/db` |
| Questions about the Future Ideas board's cards and buttons | [references/ideas.md](references/ideas.md) | Nothing more |
| A plan with no `_plan` | [references/older-plans.md](references/older-plans.md), plus [references/older-selections.md](references/older-selections.md) for future ideas | Its steps for the request |

## Record updates

When the request says what to change and where ("mark 2.3 done", "add an outcome to F7.1: …", "rename 4.2 to …", "move Settings Menu ahead of Kept Programs", "add a future idea: …"), nothing needs reading:

1. **One message**, with these calls in this order:
   - Only when adding parts: `Write` them in the [plan source](#the-plan-source) format to `<scratchpad>/add.txt`.
   - Bash: `plan.py record <scratchpad>/r.json` with everything the request asks for (table below).
   - `ArtifactData` `set` on the plan's `url`: collection `statuses`, a new record id, `file_path` `<scratchpad>/r.json`.
   - `ArtifactData` `get` of `plan/_plan` and of `statuses/_meta`.
2. **Reply** in one sentence saying what changed.
   - No `_plan`: it's an older plan. A statuses-only record is done if `statuses/_meta` exists. Otherwise `delete` the record (`if_version` 1) in the first message of [references/older-plans.md](references/older-plans.md) and make the change that way.
   - If the `set` was refused because the record exists, send it again with a new id.

| For | `record` option (any number, all in one record) |
|---|---|
| Statuses | `2.3=done F7.1=progress` (`todo`, `progress`, `done`, `blocked`, `skipped`) |
| An Outcome | `--outcome 2.3 "TEXT"` |
| A note (a paragraph at the end of the step) | `--note 2.3 "TEXT"` |
| A new name | `--rename T "New Name"` |
| A word swap the user spelled out | `--swap T "old words" "new words"`; `--swap 4.2:What …` only under that `<h5>` |
| New text for a whole field | `--set T FIELD "TEXT"` or `@file`: `body` (step, section), `intro` (phase), `desc` or `short` (feature), `sentence` or `details` (idea), `summary` (plan) |
| A move | `--move T before REF` or `after` |
| New steps | `--add <scratchpad>/add.txt` with `--phase 2` (at its end), `--after 2.3` or `--before 2.3` |
| A new phase, planned feature, section or idea | `--add <scratchpad>/add.txt` (after the last of its kind; `--after 2` for a phase) |

- **Targets (T):** a step (`4.2`, `F8.1`), a phase or feature (`2`, `F8`), a name exactly as shown, `idea:<id>`, `section:<id>`, a doc id, or `plan`. Numbers mean the plan before this record, so use the user's. When the script warns that planned features may renumber, target by doc id in later records.
- **TEXT** is one paragraph and may use `<code>`, `<strong>` and `<em>`. Write step numbers as plain text (`F7.2`): they become references that follow their step. A list or a long note goes in a fragment with `--set` or `--add`.
- **Skipped steps and core phases keep their place**, so add no move for them. Planned features re-sort by status (done, in progress, not started, skipped) and renumber, so give the new numbers in the reply. Before the plan's first snapshot (no `_plan.statusOrder`), move a fully skipped feature after the last one yourself.
- **Record ids:** `r-`, today's `YYYYMMDD`, a word for the update (`2.3-done`, `outcome`, `rename`, `add`, `move`, `idea`) and four random letters: `r-20261020-add-qkxw`.
- A word swap whose old words aren't there changes nothing, and the next outline lists it. Redo it as a lookup update when it matters.

## Lookup updates

When you need to see the plan first:

1. **One message:** list `plan` and `statuses` to `<scratchpad>/db`, then Bash `plan.py outline <scratchpad>/db --show 4.2`, naming what the update is about (`F8`, `idea:<id>`, `section:<id>`, doc ids). It prints every part with its number, status and doc id, the shown parts' text, and records that changed nothing.
2. **One message:**
   - For new text, `Write` the fragment first.
   - Bash, writing `<scratchpad>/w/record.json` after checking the text or place exists:
     - `plan.py edit <scratchpad>/db T --out <scratchpad>/w` with `--name`, `--replace "old" "new"` (repeatable; `--in What` for one `<h5>`), `--body FILE`, `--intro`, `--sentence`, `--details FILE`, `--status`, `--outcome`.
     - `plan.py add <scratchpad>/add.txt --db <scratchpad>/db --out <scratchpad>/w --after 2.3` (or `--phase N`, `--before`).
     - `plan.py move <scratchpad>/db 2.3 --before 2.1 --out <scratchpad>/w`.
     - Anything else: `plan.py record`, as above.
   - `ArtifactData` `set` of a new `statuses` record with `file_path` `<scratchpad>/w/record.json`.
3. **Reply** in one sentence.

No `_plan` in the list: follow [references/older-plans.md](references/older-plans.md). If the script stops with an error, it wrote nothing and the `set` fails too: fix it and send both again.

## Reading a plan for context

1. **One message:** Artifact `open` of the plan's `url` (it puts the plan back in the side pane), list `plan` and `statuses` to `<scratchpad>/plan/db`, then Bash `plan.py outline <scratchpad>/plan/db --show F8`, naming what the work is about.
2. Work from that, with more `--show` later if needed. No `_plan`: read it as [references/older-plans.md](references/older-plans.md) says.

## Where a new idea goes

When the user doesn't say whether an addition belongs in the core plan or the future ideas: while every step is Not started, add it to the core plan (new steps, or a new phase); once any step has started, add it as an undecided `## Idea:`. An idea gets no steps until the user accepts it or asks to plan it ([references/selections.md](references/selections.md)), however much detail they give: that goes in its details.

## The plan source

New parts are written under light headings, in page order:

```
## Phase: Search Index {#search-index}
About a week. Done when every recipe is in the index.

### Step: Index Recipe Titles and Tags [done] {#index-titles}
<h5>What</h5>
<p>What this step changes or produces.</p>
<h5>How</h5>
<ul>
  <li>How it's done.</li>
</ul>
<h5>Why</h5>
<p>Why it's needed.</p>

## Feature: Saved Searches | Searches {#saved-searches}
One sentence on what the planned feature adds.

### Step: Save a Search {#save-a-search}
<h5>What</h5>
<p>…</p>

## Section: Risks {#risks}
<p>Background text, subheadings, lists, tables and diagrams, as on the page.</p>

## Idea: Saved Searches {#saved-searches}
One or two sentences on what it would add.
<h5>Options</h5>
<p>Optional details.</p>
```

- **Title case, Chicago style**, for the plan's title and every name and heading: "Point Your Global Instructions at It", "Move the Parser into my-utils".
- `{#id}` (lowercase words joined by hyphens) sets a part's doc id, so the reply can say where it went. A step's status in `[…]` defaults to `todo`. A phase's first plain line is its intro, a feature's its description (`| Short` after its name is the overview's one- or two-word name), and an idea's first paragraph its sentence.
- Content is the page's own HTML, unindented; a paragraph can be plain text. Step details use `<h5>` subheadings, **What / How / Why** by default, plus **Done When**, **Files**, **Depends On** or **Risks** where they matter, and a caveat goes in `<div class="note">…</div>`. Tables and diagrams as [references/making.md](references/making.md) describes. The script refuses tags and classes the page doesn't show, such as `<img>`, `style` or a link that isn't `https://` or `#…`.
- Never write the overview, numbers, phase statuses, progress, card wrappers or the header: the page works them out.
- Finished steps keep their details; an Outcome says what happened when it differs from the plan, or when the user gives one.

## Files

| File | Read when |
|---|---|
| [scripts/plan.py](scripts/plan.py) | Changing it; otherwise run it as above. It uses `dbplan.py`, `htmlplan.py` and `apply_selections.py` beside it |
| [assets/](assets/) | Changing how every plan looks or behaves (never one plan's page) |
| [evals/triggers.json](evals/triggers.json) | Changing the description |

## Improving this skill

The tool folder's `CLAUDE.md` holds the standing traps and how to test. After any change to the scripts or `plan.js`, run `python -I tests/run_all.py` from the tool folder.
