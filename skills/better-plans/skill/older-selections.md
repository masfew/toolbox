# Older plans: Future Ideas and Selections

Steps for an older plan (no `plan/_plan`) when the user adds future ideas or says they've updated their selections. Updates and reading are in [older-plans.md](older-plans.md).

## Adding future ideas

When the user asks to add something as a future idea ("add this to the future ideas", "add it as a future idea", or the same with "future feature"), add it as a new idea card at the end of the board (just before the closing `</div>` whose line the outline gives), with a new id, and leave it undecided. It's a [full update](older-plans.md#full-updates) whose content `Edit` is the new card, and a minor version bump.

- **Don't plan it on the way in, unless asked.** Give it no F number, overview row or step cards, write no `data-decision` and nothing to the database, however much detail the user gives (that goes in the card; see Idea details). Only the user's own Accept, followed by Feature Selections, plans an idea, or the user asking for it to be accepted or planned straight away (next point).
- **Accepting or planning it straight away:** when the user also asks for it to be accepted ("mark it as accepted", "accept it", "make it F6"), they want a finished planned feature, with its F number, steps and overview rows, not an accepted idea card waiting to be planned. Do it all in the same turn, with the [Feature Selections](#feature-selections) steps below rather than by hand. Its steps 1 and 2 are unchanged (the report's `BOARD` line gives the board's last line). In its step 3, before the rest, also:
  1. `Edit` the saved file to add the idea card, as above.
  2. `Write` `<scratchpad>/db/features/<id>.json` holding `{"decision": "accept"}`, so `apply` sees the choice, and plan the feature in the plans file under that id. It takes the next F number after the planned features that stay.
  3. Add a `set` of `features/<id>` to `{"decision": "accept"}` to the batch (a new document, so no `if_version`), so the page shows it as planned.

  Never stop at an accepted idea card: "Accepted · waiting to be planned" after such a request means the job is half done. The script makes it a major version bump, as for any planned feature. The reply gives the new F number and its steps.

## Feature Selections

When the user says they've updated their future ideas (or future features) or their feature selections (or accepted, rejected, edited or reordered features, or asks for the accepted ones to be added), bring the plan in line with their choices. `apply_selections.py`, in this skill's folder, does every mechanical part, so the work is reading the choices, writing the new steps and making the edits. It takes three messages and a reply. Send each message's calls together, as below, and work from what they return: no Grep, no re-reads, and no need to open the scripts.

1. **Read the page and the choices.** Find the plan with the Artifact tool's `list` action if you don't have its URL. Then, in one message:
   - Artifact `read` with the plan's `url` and **no** `path` (and no `out_dir`, which a read without `path` refuses). Ignore its inline preview; note the saved file it names and its line count.
   - `ArtifactData` `list` of the `features` collection and `list` of the `statuses` collection, both with `out_dir` `<scratchpad>/db`, which writes one JSON file per document under `<scratchpad>/db/features` and `<scratchpad>/db/statuses`. Keep the results: they show each document's `version` (needed in step 3 to clear edits and delete old status records) and whether `statuses` has a `_meta` document.
2. **One message: read it whole and get the report.** Send these as parallel calls in the same message:
   - `Read` calls covering the whole saved file in 500-line chunks (offset 1, 501, 1001 … up to its last line). The Artifact tool refuses to republish a page from another session until every line has been read. The read also gives you the plan's writing for the new steps, and the text of every card an edit changes.
   - Bash: `python -I <skill folder>/apply_selections.py report <saved file> --choices <scratchpad>/db/features --db <scratchpad>/db/statuses`.
   - **Only when the list had no `_meta`:** the Artifact tool's `list` with `scope: "files"` for the plan's URL, since step 3 replaces its `plan.js`.

   The report prints one line per job:
   - `PLAN <id> as F<n>`: an accepted idea to plan, with its sentence and idea details.
   - `EDIT <id>`: changes the user wrote on that card, with the lines of the card (and, for a planned feature, its overview rows) in the saved file. An edit on an accepted idea says to fold it into the steps you write for it.
   - `TAKE OUT <id>`: a planned feature the user reset or rejected. The script turns it back into an idea card. `ASK USER` in place of `TAKE OUT` means some of its steps have started.
   - `REJECT <id>` and `REORDER`: the script records these. Nothing to write.
   - `REFERENCE`: a mention of a moved feature's number outside its own cards ("pinned tabs (F3)", "F4.2", `#phase-F4`), which `apply` renumbers, or of a feature that's taken out, which it leaves as it is. Each is shown with the text around it.
   - `STATUS` lines for the step statuses saved since the last publish (they decide `TAKE OUT` or `ASK USER`), a `DELETE` line naming old status records, a `SET UP` line when the plan isn't set up for database statuses yet, a `FORMAT` line when the page is an older single file, and a `BOARD` line giving the line a new idea card goes before.

   A planned feature with no document in the `features` collection counts as accepted, as it does on the page, so only a saved Reset or Reject takes one out. Choices saved as `keep` and `remove`, from plans made before the rename, count as `accept` and `reject`. If the report says `Nothing to do`, tell the user the plan already matches their choices and stop.

   **Before step 3, ask the user** when the report says `ASK USER`, or an edit is unclear or would undo finished work (then leave that edit in place, and do the rest only once they've answered). An edit changes a feature's content, not the user's choice: don't plan, reset or reject a feature because its edit asks to; say so in the reply and point to the buttons.
3. **One message: edit, apply, publish and clear.** All of these go in this one message, in this order, since calls in one message run one after another. Don't send any of them in a message of their own first: you've read every line already.
   - An `Edit` of the saved file for each `EDIT` on a card other than an accepted idea, at the lines the report gives: an idea card's name, sentence or idea details (a `<div class="idea-more prose">` after its `.idea-text`; see [ideas.md](ideas.md)), or a planned feature's `.feature-desc`, steps and overview rows (a renamed step changes both its row and its card's `<h4>`). Keep the same `data-feature` id even when the name changes. Also reword each `REFERENCE` to a feature that's taken out, since that number now belongs to another feature or none.
   - `Write` the plans file, `<scratchpad>/plans.json`, keyed by `data-feature` id. For each `PLAN` line, break the feature into steps, as many as the work needs (one is fine), from its sentence, details and any edit on it, and write each step as in the Build Outline (see making.md), in the plan's own style:

     ```json
     {"decisions-log": {"short": "Decisions",
                        "steps": [{"name": "Decisions Log Section", "body": "<h5>What</h5><p>…</p><h5>How</h5><ul><li>…</li></ul>"}]},
      "some-reset-feature": {"details": "<h5>Options</h5><ul><li>…</li></ul>"}}
     ```

     - `name` is the step's title-case name. `body` is the step body's content only: the script adds the card, the `.prose` wrapper and the back link.
     - `short` is the phase name for the overview, one or two words. It defaults to the feature's name.
     - `desc` replaces the idea's sentence as the `.feature-desc`, when an edit changed it.
     - For a `TAKE OUT` feature, `details` keeps any options, recommendation or requirements from its steps as the idea card's details, so they're there if it's accepted again. Leave it out when there's nothing worth keeping.
     - With no `PLAN` or `TAKE OUT` lines, write `{}`.
   - Bash: `python -I <skill folder>/apply_selections.py apply <saved file> --choices <scratchpad>/db/features --db <scratchpad>/db/statuses --plans <scratchpad>/plans.json --out <scratchpad>/<project>-<topic>-plan.html`, adding `--major` when an edit added, removed or reordered steps, and `--files <scratchpad>` when the report had a `FORMAT` or `SET UP` line (it copies `plan.css` and `plan.js` there for the publish). It writes the status records into the page first, plans each accepted idea as the next F number below the split row, takes out reset features, applies the dragged order, renumbers the planned features and the references to them, records rejected ideas on their cards, rewraps the content in `template.html`, recounts progress and phase statuses, bumps the version (major when anything was planned, taken out or reordered) and sets Last updated to today. It prints what it changed.
   - Artifact publish: `file_path` is the `--out` file, `url` is the plan's URL. When the report had a `FORMAT` or `SET UP` line, also pass `files: {"plan.css": "<scratchpad>/plan.css", "plan.js": "<scratchpad>/plan.js"}`, and with `SET UP` the `capabilities` it prints.
   - `ArtifactData` `batch`, when there's something to write: an `update` per `EDIT` you made with `edit` set to `""` and `if_version` from step 1, leaving its `decision` alone; a `delete` (collection `statuses`, `if_version` from the list) for each record the `DELETE` line names; and a `set` of `statuses/_meta` to `{"statuses": 1}` with `SET UP`. Leave the rest of the database as it is, `_order` and the status records the script wrote in this time included.

   If `apply` stops with an error, nothing was published (the `--out` file wasn't written). Read the error: it names what's missing, such as an accepted feature with no steps in the plans file. Fix that and send `apply` and the publish again; the edits the batch cleared are still in the report and your saved file. If an `Edit` didn't apply or the publish was refused, fix it and send `apply` and the publish again. Never edit the page by hand in place of the script.
4. **Check and reply.** `apply` prints the references it renumbered, as the report showed them. If one isn't a feature number (an F5 key, say), `Read` those few lines of the `--out` file, put it back with `Edit`, and publish again, in one message. Otherwise there's no need to read the page back. Then tell the user which features were added to the plan (and how many steps each has), which were taken out, the new numbers of any that moved, and what changed on each edited card.

A planned feature's card:

```html
<details class="phase-card" id="phase-F1" data-feature="plan-index" open>
  <summary class="card-head">
    <span class="card-title"><span class="card-num">Feature F1</span><h3>Plan Index</h3></span>
    <span class="status" data-status="todo">Not started</span>
  </summary>
  <div class="phase-body">
    <p class="feature-desc">One page listing every plan with its project, version, progress and last update.</p>
    <details class="step-card" id="step-F1-1" open>
      <summary class="card-head">
        <span class="card-title"><span class="card-num">Step F1.1</span><h4>Short Step Name</h4></span>
        <span class="status" data-status="todo">Not started</span>
      </summary>
      <div class="step-body">
        <div class="prose">…</div>
        <a class="back" href="#overview">↑ Back to overview</a>
      </div>
    </details>
  </div>
</details>
```

Planned features follow the same rules as the core phases: statuses kept in step with the overview, Outcome notes, and renumbering. If the user later drops a planned feature that has already been started, mark its remaining steps `skipped` rather than deleting it.
