# Feature Selections

When the user says they've updated their future ideas (or future features) or their feature selections (or accepted, rejected, edited or reordered features, or asks for the accepted ones to be added), bring the plan in line with their choices. The page saves every Accept, Reject, Recover, Reset, edit and drag as the user makes them: rejects, recovers and drags need nothing from Claude (a drag renumbers the planned features at once). Accepted ideas need planning, edits need making, and reset or rejected planned features need taking out. It's three messages, and the steps for older plans (no `plan/_plan`) are in [older-selections.md](older-selections.md).

1. **One message:** `ArtifactData` `list` of collections `plan`, `statuses` and `features`, each with `out_dir` `<scratchpad>/db` and `query: {"limit": 1000}`, then Bash `python -I <skill folder>/plan.py outline <scratchpad>/db --jobs`. Keep the `features` list result: it shows each document's `version`. The outline's "Future ideas to bring in" lines are the jobs:
   - `PLAN <id> as F<n>`: an accepted idea, with its sentence and details shown (and its edit, to fold in).
   - `EDIT idea:<id>`: the change the user wrote on an idea card, with its text shown.
   - `EDIT F<n>`: the change the user wrote on a planned feature, with its steps shown.
   - `TAKE OUT <id>`: a planned feature the user reset or rejected, back to an idea card. `ASK USER` in its place means some of its steps have started.

   With no jobs, tell the user the plan already matches their choices and stop. Before step 2, ask the user when a line says `ASK USER`, or an edit is unclear or would undo finished work. An edit changes a feature's content, not the user's choice: don't plan, reset or reject a feature because its edit asks to; say so in the reply and point to the buttons.
2. **One message**, in this order:
   - For each `PLAN`: break the feature into steps, as many as the work needs (one is fine), from its sentence, details and any edit on it, in the plan's own style. `Write` them all to `<scratchpad>/plan.txt` as `## Feature: Name | Short {#<id>}` (the idea's own id; Short is the overview's one- or two-word name), its one-sentence description, then `### Step: Name {#step-id}` parts (the plan source in SKILL.md).
   - For a `TAKE OUT` whose steps hold options, a recommendation or requirements worth keeping: `Write` them as idea details to `<scratchpad>/out-<id>.txt`.
   - For each `EDIT` that rewrites a whole idea's details or a step's body: `Write` the new text to a file.
   - Bash: one `python -I <skill folder>/plan.py record <scratchpad>/r.json` with all of it: `--add <scratchpad>/plan.txt` for the plans; `--takeout <id> [<scratchpad>/out-<id>.txt]` for each take-out; for each edit `--rename idea:<id> "New Name"`, `--set idea:<id> sentence "…"`, `--set idea:<id> details @<file>`, or on a planned feature `--rename F8 "…"`, `--set F8 desc "…"`, `--swap F8.2 "old" "new"`, `--set F8.2 body @<file>`, and `--add` for new steps on it.
   - `ArtifactData` `batch`: a `set` of a new `statuses` record (`doc_id` as in SKILL.md, word `plan`) with `file_path` `<scratchpad>/r.json`, and an `update` of each `features/<id>` whose edit you made (planned ideas with an edit included) setting `edit` to `""`, with `if_version` from the list. Leave `decision` alone.
3. **Reply:** which features were added (their F numbers and how many steps each), which were taken out, and what changed on each edited card.

A planned feature is numbered after the planned features already there (F numbers come from their order), and its idea card goes from the board by itself. A taken-out feature becomes an idea card again, at the end of the board, keeping the user's choice (undecided, or in Rejected).

## Accepting or planning an idea straight away

When the user asks for a new or existing idea to be accepted or planned ("add it and accept it", "make it F9", "plan the Strava idea now"), they want a finished planned feature with its F number and steps, not an accepted idea waiting to be planned. That's a record update (SKILL.md): `Write` the `## Feature:` part with its steps (the idea's id when it already has a card, so the card goes) and send `record --add`. A planned feature with no saved choice counts as accepted, so nothing else is written. The reply gives the new F number and its steps.

If the user later drops a planned feature that has already been started, mark its remaining steps `skipped` rather than taking it out.
