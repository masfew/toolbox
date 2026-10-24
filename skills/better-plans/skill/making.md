# Making a plan

The rules for building a plan page and its sections, for a new plan and for steps, phases or sections added to one. Headings and the update steps are in SKILL.md, and the Future Ideas section's markup and behaviour in [ideas.md](ideas.md).

A new plan isn't written as HTML. Claude writes a short **plan source** (the plan's own words under light headings, below) and `plan.py new` builds the page from it: the template around it, the header with the version and dates, the overview table, the progress label, phase statuses, the phase and step cards, back links and the Future Ideas board. So there's no template to read and no overview to keep in step with the cards.

## Steps

1. **Write the plan and publish it.** Work out the plan's content following the core sections below and, in the same message, send these three calls in this order (calls in one message run one after another):
   - `Write` the plan source to `<scratchpad>/<project>-<topic>-plan.txt` (in the project instead, if the user wants the page there).
   - Bash: `python -I <skill folder>/plan.py new <scratchpad>/<project>-<topic>-plan.txt --files <scratchpad>`. It writes the page beside the source as `<project>-<topic>-plan.html` (the plan's first snapshot), its entries as `<scratchpad>/seed/_plan.json` and `<scratchpad>/seed/_seed.json` (it names a `_seed2.json` too for a very large plan), and copies `plan.css` and `plan.js` into the scratchpad, since the Artifact tool only publishes supporting files from the session's working directory or scratchpad.
   - Artifact publish:
     - `file_path` is the page, `<scratchpad>/<project>-<topic>-plan.html`.
     - The title is the project or game name plus the topic, in title case (see Headings in SKILL.md), for example "Recipe Box Search Plan". It's the source's `#` line, which the script puts in both the `<title>` and the `<h1>`; pass the same text as `title`.
     - The `description` gives the project folder path and the date.
     - The `icon` is `checklist`.
     - `files: {"plan.css": "<scratchpad>/plan.css", "plan.js": "<scratchpad>/plan.js"}`, which publishes the styles and script beside the page.
     - `capabilities: {"db": {"rules": [{"path": "features", "read": "view", "write": "admin"}, {"path": "statuses", "read": "view", "write": "admin"}, {"path": "plan", "read": "view", "write": "admin"}]}, "user": {}, "artifact": {}}`. The database holds the plan and its updates, which every viewer can read and only the owner and editors can change; `artifact` lets the page's Save Snapshot button republish it. Leave `capabilities` out of any later publish, so the declaration carries over.

   If `plan.py new` finds a mistake in the source (a step before any phase, an unknown status, an unclosed tag, a tag the page won't show), it stops with the line number and writes nothing, so the publish fails too. Fix that line with `Edit`, then send the Bash and the publish again.
2. **Reply** with the link, and in the same message save the plan's entries: `ArtifactData` `batch` with the plan's `url` and three writes, `set` of `plan/_plan` with `file_path` `<scratchpad>/seed/_plan.json`, `set` of `plan/_seed` with `file_path` `<scratchpad>/seed/_seed.json` (and `_seed2` if the script named one), and `set` of `statuses/_meta` with `data` `{"statuses": 1}`. Until they're saved the page shows its snapshot, which is the same plan.

## The plan source

The parts go in page order. Each starts with a heading line; everything up to the next heading line is that part's content.

```
# Recipe Box Search Plan

The summary paragraph (see Summary below).

## Section: Goals and Scope
<p>Background text, subheadings, lists, tables and diagrams, as on the page.</p>

## Phase: Search Index
About a week. Done when every recipe is in the index.

### Step: Index Recipe Titles and Tags [done]
<h5>What</h5>
<p>What this step changes or produces.</p>
<h5>How</h5>
<ul>
  <li>How it's done.</li>
</ul>
<h5>Why</h5>
<p>Why it's needed.</p>

### Step: Search Box on the Home Page
<h5>What</h5>
<p>…</p>

## Idea: Saved Searches
One or two sentences on what it would add.
<h5>Options</h5>
<p>Optional details, as on the card's drop-down.</p>
```

- **`# Title`:** the first line. The summary paragraph follows it.
- **`## Section: Name`:** an extra section (see Sections the Template Doesn't Have), placed between the plan overview and the Build Outline in the order written. Its id is made from the name (`goals-and-scope`); add `{#id}` after the name to choose another.
- **`## Phase: Name`:** a phase, numbered in order. An optional intro sentence under it becomes the phase intro. `{#id}` after the name is optional (its database id; it's made from the name otherwise).
- **`### Step: Name [status]`:** a step in the phase above it, numbered in order, with its details under it. The status is `todo` (the default, so leave it out), `progress`, `done`, `blocked` or `skipped`. The name is used word for word in both the overview row and the card. `{#id}` after it is optional, as for phases.
- **`## Idea: Name`:** a future idea card, in the order the ideas came up. Its first paragraph is the one or two sentences; anything after it becomes the card's details. Its id (`data-feature`) is made from the name (`saved-searches`); add `{#id}` to choose another. With no ideas, the board says there are none yet.
- **`## Styles`:** rarely needed: plan-specific CSS (see New styles below), which the script puts in a `<style>` block marked `/* plan-specific */`.

Content is the HTML the page uses, written without indentation or wrappers:
- A paragraph can be plain text, ended by a blank line or a line starting with a tag, and the script wraps it in `<p>`.
- A bare `<table>` gets the `.table-wrap` around it (and `class="table"`), and a bare `<svg>` the `.diagram` div.
- In an extra section, the script puts runs of text, subheadings and lists in a `.prose` div, and leaves `<div>` blocks (`.diagram`, `.note`, `.table-wrap`, `.prose`) as they are.
- Step details and idea details go in the card's `.prose` div as written.

Never write the overview, statuses, phase statuses, the progress label, card wrappers, back links or the header: the script works them all out.

## Core sections

Every plan has these five sections, in the template's markup. Any extra sections the plan needs (see Sections the Template Doesn't Have) go between the plan overview and the Build Outline, so the page reads:

1. Header
2. Summary
3. Plan Overview
4. Extra sections: the plan's background and other content
5. Build Outline
6. Future Ideas (its markup is in [ideas.md](ideas.md))

The markup notes below describe the page `plan.py new` and the page's script build; Claude only writes them by hand on an older plan (see [older-plans.md](older-plans.md)).

### 1. Header

The `<h1>` title on the left, with **Version**, **Created** and **Last updated** stacked in the small list to its right (the `.meta` list inside `.plan-top`).

- Write dates as `17 Oct 2026`, with the ISO date in the `datetime` attribute.
- A new plan is version `1.0`, with both dates set to today.

### 2. Summary

One paragraph of two to four sentences, in the header under the title row (`.summary`). It says what the plan does, what it's for, and what's true once it's finished. Use no lists and no headings.

### 3. Plan overview

A table of every step in the plan, grouped into phases, under the heading **Plan Overview**. It has three columns: Phase, Step and Status.

**Phases.** Group the steps into phases: stages of the work that make sense on their own, such as "Structure", "Core loop" or "Polish".
- **Size:** most plans have two to five phases. A phase can hold a single step. A very small plan (four steps or fewer) may have just one phase.
- **Name:** one or two words, since the overview's phase cell holds the bare number and the name on one short line, so a one-step phase is no taller than any other row. There is no per-phase count.
- **Order:** the page sorts phases (and, separately, planned features) by status: done, then in progress or blocked, then not started, then skipped, keeping written order within each group, and numbers them in that order. Write them in the order the work will happen.
- **Collapsing:** clicking a phase cell folds its rows to one line. Done and skipped phases start folded; the rest start open, and a phase folds by itself once it finishes. A user's own fold or unfold holds until the phase's finished state changes.
- **Markup:** each phase is one `<tbody data-phase="N">`. Its first row starts with the phase cell, a `<th class="phase" scope="rowgroup" rowspan="…" data-target="phase-N" tabindex="0">`, holding the number (`.ph-num`, "1" rather than "Phase 1") and the name (`.ph-name`). Set `rowspan` to the number of steps in the phase.

**Steps.** Number each step `phase.step`: 1.1, 1.2, 2.1, and so on.
- **Name:** a short phrase in title case, ideally three to six words and never more than one sentence, for example "Template with the Core Sections". Write it as plain text with no code formatting.
- **Row:** the whole row is the link, with no `<a>` tags in it. Each step's `<tr>` carries `data-target="step-N-M"` (dots become dashes) and `tabindex="0"`. The template's script makes rows jump to their step and phase cells jump to their phase.
- **Step cell:** the number in a `.sn` span, then the step's short name as plain text. The cell carries `data-step="N.M"`.

**Planned features.** Future ideas the user accepted and Claude has planned (see [selections.md](selections.md)) go at the bottom of the table, below a split row, as phases numbered F1, F2 and so on, with steps F1.1, F1.2. The split row is added with the first planned feature:

```html
<tbody class="split"><tr><th scope="colgroup" colspan="3">Future Ideas</th></tr></tbody>
<tbody data-phase="F1">
  <tr data-target="step-F1-1" tabindex="0">
    <th class="phase" scope="rowgroup" rowspan="1" data-target="phase-F1" tabindex="0"><span class="ph"><span class="ph-num">F1</span><span class="ph-name">Plan Index</span></span></th>
    <td class="step" data-step="F1.1"><span class="sn">F1.1</span> Short Step Name</td>
    <td class="st"><span class="status" data-status="todo">Not started</span></td>
  </tr>
</tbody>
```

**Progress label.** The overall `X of Y done` label counts every step, planned features included. The script recalculates it, but the static text should already be right (`plan.py new` and `finish` write it).

**Status.** The status is a `<span class="status" data-status="…">` with exactly one of these pairs:

| `data-status` | Label | Use for |
|---|---|---|
| `todo` | Not started | Work not begun |
| `progress` | In progress | Being worked on now |
| `done` | Done | Finished |
| `blocked` | Blocked | Can't move until something else happens. Say what in the step's details. |
| `skipped` | Skipped | Dropped from the plan. Keep the row, and say why in the details. |

Skipped steps don't count towards the progress label's total.

### 4. Build Outline

The full details of every step, under the heading **Build Outline**, as cards: one card per phase, in the same order as the overview, each holding one card per step. Every card is a `<details>` element whose `<summary class="card-head">` is its header, so clicking the header collapses or expands that card.

- **Phase intro:** when a phase has a goal, an estimate or a finish line of its own, put it in one short `<p class="phase-desc">` at the top of the phase body, before the step cards (in a source, the sentence under the `## Phase:` line). For example: "About a week. A window running the CLI that already looks the part. Done when login, paste and resizing all work." Leave it out when there's nothing to say beyond the steps.
- **Phase status:** worked out from its steps. It's Done when every step that isn't skipped is done, Blocked if any step is blocked, In progress if any step is in progress or done, and Not started otherwise. The script recalculates it, and `plan.py` writes it.
- **Content:** include whatever helps someone understand or carry out the step: what it changes or produces, how it's done, and why. Use `<h5>` subheadings. **What / How / Why** is the default set. Add **Done when**, **Files**, **Depends on** or **Risks** where they matter, and drop any that would be empty or obvious.
- **Format:** write short paragraphs and short lists. Put a caveat or dependency in a `.note`.
- **Phase card markup:** `<details class="phase-card" id="phase-N" open>`. Its summary holds a `.card-title` (a `.card-num` reading "Phase N", then the name in an `<h3>`) followed by the phase's status pill. The step cards go inside a `<div class="phase-body">`.
- **Step card markup:** `<details class="step-card" id="step-N-M" open>`. Its summary holds a `.card-title` (a `.card-num` reading "Step N.M", then the name in an `<h4>`, word for word the overview's name) followed by the step's status pill, the same status as the overview. Everything else goes inside a `<div class="step-body">`: the details in a `<div class="prose">`, then the `↑ Back to overview` link (`<a class="back" href="#overview">`).
- **Collapsing:** write `open` on every card and leave it there. When the page loads, the script leaves only in-progress steps open, along with the phases that hold them, and collapses every other card. Jumping to a card from the overview opens it.
- **Back to next step:** once the plan overview has scrolled out of view, the script shows a round button in the bottom-right corner that glides back up to the overview's first row that isn't done or skipped (core steps first, then planned features), a third of the way down the window. With every row finished it goes to the top of the page. It needs no markup, only the overview's `id="overview"`.

### 5. Future Ideas

Ideas that could come later but aren't part of the plan yet, as idea cards the user accepts or rejects (markup and behaviour in [ideas.md](ideas.md)). Each has a short name in title case and one or two sentences on what it would add. When there's more to say (options to choose between, a recommendation, requirements, open questions, notes from the conversation), write it as the idea's details, like a step body: short paragraphs, short lists, `<h5>` subheadings such as **Options**, **Recommendation** or **Must**, and a `.note` for a caveat. Never plan an idea on the way in: no steps or overview rows for it, however much detail the user gives.

## Sections the template doesn't have

When a plan needs more than the core sections, for example goals and scope, architecture, a tech stack, a testing approach, tuning values, options compared, or risks, follow these rules:

- **Placement:** add each extra section between the Plan Overview and the Build Outline, as `<section class="block block-extra" id="…">` with an `<h2>` (in a source, a `## Section:` part). The `block-extra` class spaces out the blocks stacked inside it and draws the hairline rule above the section that separates it from the one before. The Build Outline gets the same rule on its own, so don't add rules or dividers by hand. Put background (goals, scope, how it works) first, then the rest in the order a reader needs it.
- **Building blocks:** build the content only from the template's existing ones:
  - running text and `<h4>` subheadings in `.prose`
  - tables (`.table-wrap` > `table.table`)
  - `.note` asides
  - `<code>`
  - diagrams (`.diagram`, below)
- **Diagrams:** when a picture explains something better than text (an architecture, a flow), draw it as an inline SVG inside `<div class="diagram">`. Use only the template's diagram classes for colour, never fixed colours, so it follows light and dark mode:
  - `d-box` for a box, and `d-main` for the one box the diagram is about
  - `d-edge` for connecting lines, with an arrowhead `<marker>` whose path is `d-head`
  - `d-name` for a box's name, `d-sub` for smaller labels, and `d-main-sub` for smaller labels inside the `d-main` box

  Give the `<svg>` a `viewBox`, `role="img"` and an `aria-label` saying what it shows, and put any title in the surrounding text rather than the drawing. Keep labels short: the diagram scrolls sideways on phones rather than shrinking its text.

  ```html
  <div class="diagram">
    <svg viewBox="0 0 520 120" role="img" aria-label="The app sends files to the sidebar">
      <defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path class="d-head" d="M0 0L10 5L0 10z"/></marker></defs>
      <path class="d-edge" d="M200 60H312" marker-end="url(#arrow)"/>
      <rect class="d-box" x="4" y="24" width="196" height="72" rx="8"/>
      <text class="d-name" x="102" y="56" text-anchor="middle">App</text>
      <text class="d-sub" x="102" y="74" text-anchor="middle">sends files</text>
      <rect class="d-main" x="316" y="24" width="196" height="72" rx="8"/>
      <text class="d-name" x="414" y="56" text-anchor="middle">Sidebar</text>
      <text class="d-main-sub" x="414" y="74" text-anchor="middle">shows them</text>
    </svg>
  </div>
  ```
- **Only real content:** add an extra section only when it has something in it. Never leave an empty heading.
- **New styles:** don't add CSS. If a plan really needs a new kind of element, add the smallest possible rules in a `<style>` block marked `/* plan-specific */`, straight after the page's `plan.css` link (in a source, under `## Styles`), using the template's colour tokens. Never change `plan.css` for one plan: every plan shares it. Tell the user, so it can be considered for the template.
- **Recurring sections:** when the same kind of extra section keeps coming back across plans, add it to this skill as a named section with its markup, so later plans use the same name and layout.
