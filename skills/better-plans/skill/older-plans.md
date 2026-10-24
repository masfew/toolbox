# Older plans

Plans published before database plans keep their content in the page's HTML: the `plan` collection of their database has no `_plan` document. Every update to one republishes the page, and these are the steps. The record updates in SKILL.md still work for statuses alone (the page shows status records when `statuses/_meta` exists), but not for Outcomes, notes, renames, word swaps, moves or new parts: when a record update finds no `_plan`, delete the record it saved (`ArtifactData` `delete`, collection `statuses`, `if_version` 1) in the first message below, before the `statuses` list, and make the change this way.

The Future Ideas board's cards and buttons are in [ideas.md](ideas.md), and the page's markup in [making.md](making.md) (core sections). Adding future ideas and Feature Selections on an older plan are in [older-selections.md](older-selections.md). When editing a page, keep the template's head and script tags unchanged, and only change the content between the `PLAN CONTENT START` and `PLAN CONTENT END` comments.

## Updating an older plan

Plans are revised in place, under one URL. A plan page is up to 130 KB of HTML (200 KB for older single-file pages) and every round trip costs seconds. `plan.py`, in this skill's folder, does all the bookkeeping: run on a page (an `.html` file), its `outline` and `finish` work as before.

### Status-only updates

When the update only changes step statuses ("mark 2.3 done", "F7.1 is in progress") and nothing else on the page (no Outcome note, no rewording, no new steps or ideas), don't read or republish the page. Save the statuses as one new record in the plan's database instead, and the page shows them straight away.

1. Find the plan with the Artifact tool's `list` action if you don't have its URL. If the `ArtifactData` tool still needs loading (ToolSearch `select:ArtifactData`), load it in this message, or with the skill.
2. **One message** with these three calls, in this order (calls in one message run one after another):
   - Bash: `python -I <skill folder>/plan.py status <scratchpad>/status.json 2.3=done 2.4=progress`, with every status to change (`todo`, `progress`, `done`, `blocked`, `skipped`; planned features as `F7.1`). It writes the record (the statuses, the time and today's date), creating the folder if needed.
   - `ArtifactData` `set`: the plan's `url`, collection `statuses`, `doc_id` made of `r-`, today's date, the first step and its new status, and four random letters, such as `r-20261019-2.3-done-qkxw` (a new document every time, so it never needs a read first), and `file_path` `<scratchpad>/status.json`.
   - `ArtifactData` `get`: the plan's `url`, collection `statuses`, `doc_id` `_meta`.
3. **Reply** in one sentence, such as "Marked 2.3 done on the plan." No Artifact `read`, no `Read`s, no publish.
   - If `_meta` doesn't exist, the plan was published before database statuses: its page doesn't show the record yet. Do the full update below, with no `--status` (the record you just saved holds the statuses, and `finish --db` writes it in). It sets the plan up, so the next status change takes this path.
   - If the `set` was refused because the document exists, send it again with a new id.

The page shows the latest record for each step over the status in its HTML, and recounts the phase pills, the progress label, which cards are open, the Future Ideas groups, the edit lock and the Reset buttons from them. Each record counts as one update: the page shows the version plus 0.1 per record, and the latest record's date as Last updated. The next full update writes the records into the HTML (`finish --db`) and stamps the newest one's time on the page, after which the page ignores them, and the full update after that deletes them.

**Reading a plan's statuses** (before an update): the HTML can be behind the records. List the `statuses` collection with `ArtifactData` `list` and `out_dir` set to a scratchpad folder, in the same message as the page read, and pass that folder to `plan.py outline --db`: the outline then shows each step's current status.

### Reading a plan for context

When a session only needs a plan to work from, not to change it (a build session told to read the plan and build a step or feature, a question about the plan, or a session writing a brief from it), don't read the whole page: a plan is 30,000 to 50,000 tokens, which then stay in the session for the rest of its work. Read its outline and only the cards the work needs.

Find the plan with the Artifact tool's `list` action if you don't have its URL. Then:

1. **One message: save the page and outline it.** These three calls, in this order (calls in one message run one after another):
   - Artifact `read` with the plan's `url`, `path: "index.html"` and `out_dir` `<scratchpad>/plan`, which saves the page as `<scratchpad>/plan/index.html` without the inline preview.
   - `ArtifactData` `list` of the `statuses` collection with `out_dir` `<scratchpad>/plan/db`.
   - Bash: `python -I <skill folder>/plan.py outline <scratchpad>/plan/index.html --db <scratchpad>/plan/db`. It prints the title, version, progress and summary, every section, phase, step and idea with its current status (status records included), and the line numbers of each.
2. **One message: read what the work needs.** `Read` only those line ranges, as parallel calls: the step or feature card the work is about, and any section or other card it points to (Depends on, the architecture, an earlier step it builds on). Read more later if the work turns out to need it.

This read doesn't count as having viewed the page, which is fine, since nothing is republished. If the session later updates the plan, a status-only update needs no page read at all, and a full update does its own read and full read first (above).

### Full updates

Everything else (and a status change on a plan whose `_meta` is missing) is three messages and a short reply.

1. **Read the page and its status records.** Find the plan with the Artifact tool's `list` action if you don't have its URL. Then, in one message, `read` it with the `url` and **no** `path` (and no `out_dir`, which a read without `path` refuses), and `ArtifactData` `list` its `statuses` collection with `out_dir` set to `<scratchpad>/db`, which writes one JSON file per document under `<scratchpad>/db/statuses`. Ignore the read's inline preview; note the saved file it names and its line count. This read is what lets you republish. Keep the list result: it shows each record's `version`, and whether `_meta` is there.
2. **One message: read it whole and outline it.** Send all of these as parallel calls in the same message:
   - `Read` calls covering the whole saved file in 500-line chunks (offset 1, 501, 1001 … up to its last line). The Artifact tool refuses to republish a page from another session until every line has been read, and bigger chunks fail on size and cost another round trip.
   - Bash: `python -I <skill folder>/plan.py outline <saved file> --db <scratchpad>/db`. It prints the version, progress, every section, phase, step and idea with its status (records included), the line numbers of each overview row, step card and the Future Ideas board, and a Database line, which names any status records to delete in step 3.
   - **Only when the list had no `_meta`:** the Artifact tool's `list` with `scope: "files"` for the plan's URL, since step 3 replaces its `plan.js` (the tool only replaces files this session has listed, read or published).

   Work from these line numbers afterwards: no Grep, no re-reads. Only if this session published the page itself (earlier in this conversation) can it skip the full read: run the outline alone, and if the update changes any wording, `Read` just the line ranges it gives for those cards in the next message.
3. **One message: edit, finish and publish.** All of these go in this one message, in this order, since calls in one message run one after another. Don't send the `Edit`s in a message of their own first: you've read the lines already, and waiting for their results costs a round trip.
   - The content `Edit`s, if any: an Outcome note, reworded steps (the overview row and the card's `<h4>`), new idea cards, new or renumbered steps.
   - Bash: `python -I <skill folder>/plan.py finish <saved file> --db <scratchpad>/db --status 2.3=done 2.4=progress` with every status to change (`todo`, `progress`, `done`, `blocked`, `skipped`; planned features as `F7.1`), adding `--major` when steps or phases were added, removed, reordered or regrouped. It writes the status records into the page first, then sets each `--status` in the overview row and on the card, recounts every phase's status and the progress label, bumps the version (also 0.1 for each record it wrote in), sets Last updated and renames an older page's Future Features. With no `--status` it still does the rest, so run it on every republish. Add `--files <scratchpad>` when the outline said **Format: single file** or the list had no `_meta`: it copies `plan.css` and `plan.js` there, since the Artifact tool only publishes supporting files from the working directory or scratchpad.
   - Artifact publish: `file_path` is the saved file, `url` is the plan's URL. Send the page alone, unless:
     - the list had no `_meta`: also pass `files: {"plan.css": "<scratchpad>/plan.css", "plan.js": "<scratchpad>/plan.js"}` and `capabilities: {"db": {"rules": [{"path": "features", "read": "view", "write": "admin"}, {"path": "statuses", "read": "view", "write": "admin"}]}, "user": {}}`, which gives the plan the `plan.js` that shows status records and the rule that only the owner and editors write them;
     - otherwise, when the outline said **Format: single file** (a plan made before the styles and script moved out), `finish` moves the page to the split format: also pass the same `files`.
   - `ArtifactData` `batch`, after the publish, only when there's something to write: a `set` of `statuses/_meta` to `{"statuses": 1}` when the list had none, and a `delete` (collection `statuses`, `if_version` from the list) for each record the outline's Database line names. Never delete the records it wrote in this time: they're deleted on the next full update, once a published page is known to hold them.

   If an `Edit` didn't apply, or `finish` stops with an error (a step it can't find, say, in which case it wrote nothing), or the publish was refused, the page went out without that change: fix it, then run `finish` and the publish again.
4. **Reply** in one or two sentences: the new version and what changed. `finish` prints each change it made, so there's no need to read the page back.

Never edit statuses, phase pills, the progress label, the version or the dates by hand: `finish` does them all. The rules it follows:

- **Statuses** are set in both places, the overview row and the step's card. A phase's status follows its steps (see the Build Outline in making.md), and skipped steps don't count towards the progress label.
- **Version:** status changes and wording fixes add 0.1 (1.0 → 1.1 → 1.2, with no rollover at 1.9: next is 1.10). Adding, removing, reordering or regrouping steps or phases moves to the next major version (1.4 → 2.0): pass `--major`. A status-only update is a record rather than a republish, but it still counts: the page adds 0.1 per record to the version it shows, and `finish` adds the same when it writes them in.
- **Dates:** **Last updated** is set to today on every republish, and the page shows the latest record's date when there's a newer one. **Created** never changes.

The rest of updating a plan:
- **Renumbering:** when steps or phases are inserted or reordered, renumber them all. Update:
  - their `data-step`, `data-phase`, `data-target` and `id` values
  - the `rowspan`s
  - the numbers in the overview
  - the "Phase N" and "Step N.M" labels on the build outline cards
- **Finished steps:** keep the step's details once it's done. Add a short **Outcome** (`<h5>Outcome</h5>` and a paragraph at the end of the step's `.prose` div) when what happened differs from what was planned, or when the user gives one.
- **Leave the rest alone.** Don't restyle or restructure the page while updating it.
- **Refreshing a plan's look:** a plan keeps the `plan.css` and `plan.js` it was last published with. When the user asks for a plan to get the current look (after the template changed), do the update steps with no content edits, add the Artifact tool's `list` with `scope: "files"` for the plan's URL to step 2's message (the tool only replaces files this session has listed, read or published), and publish with the same `files` as a migration (`finish --files <scratchpad>` copies them).
- **Older plans:** plans made before the rename head the last section **Future Features**, as does their overview's split row. `plan.py finish` and `apply_selections.py` rename both to **Future Ideas** themselves.
- **Adding future ideas:** see [older-selections.md](older-selections.md#adding-future-ideas).
- **Where a new idea goes:** the rule (core plan, future idea, or ask) is in SKILL.md, Where a new idea goes. On an older plan, adding it to the core plan means new steps or a phase in the page's markup ([making.md](making.md)), renumbering as above and `--major`; adding it as an idea is [older-selections.md](older-selections.md#adding-future-ideas).


