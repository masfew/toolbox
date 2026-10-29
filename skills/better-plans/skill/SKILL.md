---
name: better-plans
description: The user's plan pages. A plan the user asks for is published as an Artifact page built from one fixed template, with step statuses, future idea cards the user accepts or rejects, and updates made in place under one URL. Use it when the user asks for a plan or roadmap by name, for a plan-mode plan once approved, and whenever revising, reading or marking progress on an existing plan, when a build session or brief says to read the plan, or when the user says they've accepted, rejected, reordered or edited future ideas, future features or feature selections, even if they don't say 'page' or 'template'. Not for a page the user asks for without calling it a plan, even one that sets out a strategy, proposal or approach for them to review (artifact-style). When the ArtifactData tool is deferred, load it with ToolSearch in the same message as this skill.
---

# Better plans

Every plan is an Artifact page built from [template.html](template.html), so that plans look and read the same from one session to the next. Its look and behaviour live in [plan.css](plan.css) and [plan.js](plan.js), published beside every plan. Don't restyle a plan: no new colours, fonts or layout, no hero banner or emoji, no rewritten CSS. The template already meets the Artifact page contract, so there's no design pass to do.

**Only for plans the user asked for.** A plan here is one the user asked for as a plan or roadmap, a plan-mode plan, or an existing plan page. A strategy, proposal, draft or write-up the user wants to see on a page isn't one when they didn't call it a plan, even when it has steps: build it as an ordinary Artifact page (artifact-design, then artifact-style if it's installed), not from this template.

**Database plans.** A plan's content (title, summary, sections, phases, steps, planned features, ideas) lives in the page's database, and the page builds itself from it every time it opens. Every new plan is one. **An update is one new record** in the plan's `statuses` collection, written by [plan.py](plan.py): no reading the page, no republish. The page replays the records over the plan's entries and shows the result at once. Numbers (2.3, F7) aren't stored, so the page renumbers by itself, and a step mentioned by number in the text follows its step.

**Older plans** were published before this and are HTML pages that are republished to change them. A plan is a database plan when its `plan` collection has a `_plan` document; every update's first message checks, and the steps for older plans are in [older-plans.md](older-plans.md) (updates, reading) and [older-selections.md](older-selections.md) (future ideas, selections).

The skill's folder is the one this file is in (`<skill folder>`); `<scratchpad>` is the session's scratchpad folder. Run the script as `python -I <skill folder>/plan.py …`. Find a plan with the Artifact tool's `list` action if you don't have its URL.

## What to do for each request

| Request | Read | First message |
|---|---|---|
| Statuses, an Outcome, added context, a rename, a word swap the user spells out, moving or adding steps, phases or sections where the user says where, adding a future idea | Nothing more | [Record updates](#record-updates) |
| Changes that need the plan's current text first (rewording a step in your own words, a change that depends on what's there) | Nothing more | [Lookup updates](#lookup-updates) |
| Read a plan to work from it (build a step, answer a question, write a brief) | Nothing more | [Reading a plan for context](#reading-a-plan-for-context) |
| Build the selected phases or features (the ones ticked in the overview), or two or more phases in one session | [building.md](building.md) | Its step 1, in the same message as the `Read`: Artifact `open` with the plan's `url`, `ArtifactData` `list` of collections `plan`, `statuses` and `features`, each with `out_dir` `<scratchpad>/plan/db` and `query: {"limit": 1000}`, then Bash `python -I <skill folder>/plan.py build <scratchpad>/plan/db` |
| The user has updated their future ideas, feature selections (Accept, Reject) or edits | [selections.md](selections.md) | Its step 1, in the same message as the `Read`: `ArtifactData` `list` of collections `plan`, `statuses` and `features`, each with `out_dir` `<scratchpad>/db` and `query: {"limit": 1000}`, then Bash `python -I <skill folder>/plan.py outline <scratchpad>/db --jobs` |
| Accept or plan an idea straight away | Nothing more | A record update with a `## Feature:` fragment ([selections.md](selections.md#accepting-or-planning-an-idea-straight-away) has the details) |
| Make a new plan | [making.md](making.md) | Nothing more: the next message writes the source and publishes |
| Batches, only when asked: a new plan with them, adding them, or building the next or a named batch | [batches.md](batches.md), plus [making.md](making.md) for a new plan | To build one: [Reading a plan for context](#reading-a-plan-for-context)'s first message, beside the `Read` |
| Save a snapshot, or the page looks out of date to someone who can't sign in | [snapshots.md](snapshots.md) | In the same message as the `Read`: `ArtifactData` `list` of collections `plan` and `statuses`, each with `out_dir` `<scratchpad>/db` and `query: {"limit": 1000}` |
| A plan whose `plan` collection has no `_plan` | [older-plans.md](older-plans.md), plus [older-selections.md](older-selections.md) for future ideas or selections | Its steps for the request |

[ideas.md](ideas.md) has the Future Ideas board's cards and buttons, for questions about them.

## Headings

The plan's title and every heading use title case, as in book and film titles: section headings, phase names, step names, future idea names, extra sections and their subheadings. Capitalise the first letter of every key word: nouns, verbs, adjectives, adverbs and pronouns ("Restyle from Your Reference Artifacts"). Keep articles (a, an, the), coordinating conjunctions (and, but, or, nor, for, so, yet) and short prepositions (as, at, by, for, from, in, into, of, on, to, up, with, within) lowercase, except as the first or last word ("Point Your Global Instructions at It"). Proper names and code names keep their own spelling ("Move the Parser into my-utils").

## Record updates

When the request says what to change and where, by step number or by name ("mark 2.3 done", "add an outcome to F7.1: …", "add to 3.2 that …", "rename 4.2 to …, and in its What say X instead of Y", "move Settings Menu ahead of Kept Programs", "add a step to Kept Programs after F7.1: …", "add a future idea: …"), nothing needs reading:

1. **One message** with these calls, in this order (calls in one message run one after another):
   - Only when adding steps, a phase, a section or an idea: `Write` them as a plan source fragment ([below](#the-plan-source)) to `<scratchpad>/add.txt`.
   - Bash: `python -I <skill folder>/plan.py record <scratchpad>/r.json …` with everything the request asks for (below).
   - `ArtifactData` `set`: the plan's `url`, collection `statuses`, a new record `doc_id` and `file_path` `<scratchpad>/r.json`.
   - `ArtifactData` `get` of `plan/_plan` (collection `plan`, `doc_id` `_plan`) and `get` of `statuses/_meta`.
2. **Reply** in one sentence: what changed (a new step's number only if you know it; the page works it out).
   - If `plan/_plan` doesn't exist, it's an older plan. When the update was statuses only and `statuses/_meta` exists, it's done (the page shows the record). Otherwise `delete` the record you saved (`if_version` 1) in the first message of the steps in [older-plans.md](older-plans.md), and do the update that way.
   - If the `set` was refused because the document exists, send it again with a new id.

What `record` takes (any number of each, all in one record):

| For | Option |
|---|---|
| Statuses | `2.3=done F7.1=progress` (`todo`, `progress`, `done`, `blocked`, `skipped`) |
| An Outcome (under an Outcome heading at the end of the step) | `--outcome 2.3 "TEXT"` |
| Added context (a paragraph at the end of the step) | `--note 2.3 "TEXT"` |
| A new name | `--rename 4.2 "New Name"` (a step, `2` or `F8` for a phase or feature, `plan` for the title) |
| A word swap the user spelled out | `--swap 4.2 "old words" "new words"`; `--swap 4.2:What …` swaps only under that `<h5>` |
| New text for a whole field | `--set T FIELD "TEXT"` or `@file` (a fragment you `Write` first): `body` of a step or section, `intro` of a phase, `desc` or `short` of a feature, `sentence` or `details` of an idea, `summary` of the plan |
| Moving a step, phase or planned feature | `--move WHAT before REF` or `after` |
| New steps | `--add <scratchpad>/add.txt --phase 2` (at its end), `--after 2.3` or `--before 2.3` |
| A new phase, planned feature, section or idea | `--add <scratchpad>/add.txt` (it goes after the last of its kind; a `## Phase:` with `--after 2` goes after phase 2) |

- **Targets** are step numbers (`4.2`, `F8.1`), phase or feature numbers (`2`, `F8`), a name exactly as the plan shows it (`"Settings Menu"`), `idea:<id>` (with or without the `i-` the outline prints), `section:<id>`, or `plan`. They mean the plan as it stands when the record is saved, so use the numbers the user gave you.
- TEXT is one paragraph and may use `<code>`, `<strong>` and `<em>`; write step and feature numbers as plain text (`F7.2`, `3.6`): the record stores them as references that follow their step. A long note or a list goes in a fragment with `--set` or `--add`.
- **Skipped goes to the bottom.** Whenever any update marks a step skipped, the same record also moves it after the last step of its phase or feature (`--move 2.3 after 2.6`), unless it's already last. Phases and planned features sort themselves (done, in progress, not started, skipped) and renumber to match, since the user wants numbers in reading order. One whose status changes group moves only as far as it must (up to the end of its new group, or down to the top of it) and stays there, so finishing or unskipping one needs no move of your own; give new numbers in the reply. That sort starts at a plan's first snapshot (`_plan.statusOrder`). Before it, and in an older plan, also move a fully skipped feature after the last one (`--move F19 after F50`), or a phase after the last phase.
- **Doc ids** of new parts come from the `{#id}` after their names in the fragment (lowercase words joined by hyphens), or their names, so the reply can say where they went without a lookup.
- **Record ids:** `r-`, today's date as `YYYYMMDD`, a word for the update (the first step and its status, such as `2.3-done`; or `outcome`, `rename`, `add`, `move`, `idea`), and four random letters: `r-20261020-add-qkxw`. A new document needs no `if_version`.
- **Version:** each record adds 0.1; one that adds, moves or takes out steps, phases or features (the script marks it) moves to the next major version. Last updated is the newest record's date. Created never changes.
- A word swap whose old words aren't there changes nothing, and the next outline lists it. Redo it as a lookup update when it matters.

## Lookup updates

When you need to see the plan first (rewording in your own words, a change that depends on the current text, a request that doesn't say where):

1. **One message:**
   - `ArtifactData` `list` of collection `plan` and of collection `statuses`, both with `out_dir` `<scratchpad>/db` and `query: {"limit": 1000}`.
   - Bash: `python -I <skill folder>/plan.py outline <scratchpad>/db --show 4.2`, naming what the update is about (step numbers, `F8` for a feature and its steps, `idea:<id>`, `section:<id>`, doc ids). It prints every part with its number, status and doc id, the shown parts' text, and any record that changed nothing.
2. **One message:**
   - For new text: `Write` the fragment first, as in record updates.
   - Bash: `python -I <skill folder>/plan.py edit <scratchpad>/db TARGET --out <scratchpad>/w` with `--name "…"`, `--replace "old" "new"` (repeat it; `--in What` for only that `<h5>`), `--body FILE` (a step's or section's details), `--intro "…"`, `--sentence "…"`, `--details FILE`, plus `--status 2.3=done` and `--outcome N TEXT` if wanted. It checks the text is there now and writes `<scratchpad>/w/record.json`. For new parts placed by what you saw: `plan.py add <scratchpad>/add.txt --db <scratchpad>/db --out <scratchpad>/w --after 2.3` (or `--phase N`, `--before`); for a move: `plan.py move <scratchpad>/db 2.3 --before 2.1 --out <scratchpad>/w`. Anything else: `plan.py record` as above.
   - `ArtifactData` `set` of a new `statuses` record with `file_path` `<scratchpad>/w/record.json`.
3. **Reply** in one sentence.

If the list has no `_plan`, it's an older plan: follow [older-plans.md](older-plans.md). If the script stops with an error (a step or text it can't find, an id that's taken), it wrote nothing and the `set` fails too: fix it and send both again.

## Reading a plan for context

When a session only needs a plan to work from (build a step, answer a question, write a brief):

1. **One message:** Artifact `open` with the plan's `url` (it puts the plan back in the session's side pane, which a `/clear` empties), then `ArtifactData` `list` of collections `plan` and `statuses` with `out_dir` `<scratchpad>/plan/db` and `query: {"limit": 1000}`, then Bash `python -I <skill folder>/plan.py outline <scratchpad>/plan/db --show F8`, naming what the work is about. The outline prints every part with its current status, and the shown parts' full text.
2. Work from that. `--show` more in a later Bash if the work turns out to need it.

If the list has no `_plan`, read it as [older-plans.md](older-plans.md) says.



## Where a new idea goes

When the user asks to add something to a plan without saying whether it belongs in the core plan or the future ideas, judge from how far the plan has got:
- **Nothing started yet** (every step is Not started): add it to the core plan, as new steps in the phase where it fits or as a new phase.
- **Work has started** (any step is In progress or Done): add it as an undecided future idea (an `## Idea:` fragment).
- **Still unsure:** if it could reasonably go either way, ask the user before adding it anywhere. Never settle a doubt by guessing.

Don't plan an idea on the way in: no steps for it, however much detail the user gives (that goes in its details). Only the user's Accept, or a request to accept or plan it, plans it (see [selections.md](selections.md)).

## The plan source

New parts are written in the plan source format, under light headings, in page order:

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

- Steps with no heading above them go where `--phase`, `--after` or `--before` say. The status in `[…]` is `todo` (the default, leave it out), `progress`, `done`, `blocked` or `skipped`. A phase's first plain line is its intro; a feature's is its description, and `| Short` after its name is the one- or two-word name for the overview; an idea's first paragraph is its sentence.
- Content is the HTML the page uses, without indentation or wrappers; a paragraph can be plain text. Step details use `<h5>` subheadings, **What / How / Why** by default, plus **Done When**, **Files**, **Depends On** or **Risks** where they matter; short paragraphs and lists; a caveat in `<div class="note">…</div>`. Tables, `<code>`, and diagrams as [making.md](making.md) describes. The page shows only the template's own tags and classes, and the script stops on anything else (an `<img>`, a `style`, a link that isn't `https://` or `#…`).
- Never write the overview, numbers, phase statuses, progress, card wrappers or the header: the page works them out.
- Finished steps keep their details; an Outcome says what happened when it differs from the plan, or when the user gives one.

## Improving this skill

This skill has no home project. The `CLAUDE.md` beside this folder (in the better-plans tool folder) holds the standing traps and how to test (keep those there, not here, since every use of the skill pays for what's in this file).

- A new rule goes in the reference file for that request (the table above); a rule every request needs goes in this file, in place of the older rule it refines.
- Look and behaviour changes go in `plan.css` and `plan.js`, never in one plan's page.
- A change to the routing table keeps each request's first calls in it: a reference `Read` in a message of its own costs a round trip.
- After any change to the scripts or `plan.js`, run `python -I tests/run_all.py` from the tool folder.
