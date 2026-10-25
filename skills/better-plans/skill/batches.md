# Batches

Read when the user asks for a plan to be run in batches (making a new plan with them, or adding them to one), or asks a session to build a plan's next batch or a named batch (SKILL.md's routing table).

A batch is a run of a plan's steps that one fresh session builds back to back, stopping only where the user is needed. The plan says which steps each batch holds, where each one stops, and how a session finds the next one, so the user can start a session with "build the next batch in the <plan>" and nothing else. **Batches are optional.** A plan has none unless the user asks for them: never add them on your own, and don't suggest them for small plans. Without them a plan looks and works exactly as the rest of this skill describes.

## The Four Pieces

A plan with batches has all four. Leave none out: the badges show where batches start, but only the section tells a session what to do.

1. **A badge in the name of each batch's first step.** Add `<kbd>Batch 3</kbd>` at the end of the step's name. Every batch is numbered and runs in order: no side batches that run alongside the others or only when named. A user once read a side batch's badge as part of the batches around it and expected their sessions to build it. The badge is part of the name, so it shows in the overview row and on the card. Only the first step of a batch gets one; a batch runs from its badge to the step before the next badge.
2. **The badge styles**, as the plan's own CSS (below). Without them the badges show as plain inline text.
3. **A Batches table and a Running a Batch subsection**, in the extra section that explains the plan's order (or a `## Section: Batches {#batches}` of its own when there's none). Both described below.
4. **One sentence in the summary** telling sessions where to start: "The work runs in N batches, one session each: a session asked for "the next batch" follows <strong>Running a Batch</strong> in the <Section Name> section before anything else."

## Choosing the Batches

- A batch ends where the user has to act: a push or publish to approve, a hands-on check, a decision, a paid run. Several steps that end in the same kind of stop can share one batch ("three pushes reviewed in one sitting").
- A batch is small enough to finish in one session's context. A phase or two of a few steps each is typical.
- Something that could break the user's setup (a switch-over, a hook that moves) ends its batch with a check, so a later break points at one change.
- Work that has to wait on something outside the plan before the next batch can start (a week of everyday use, a review) ends its batch there. The next batch's row says what it waits on, and Running a Batch has the session check it.

## The Styles

Put these rules in the plan's styles: under `## Styles` in a new plan's source, or in `_plan.styles` for an existing plan (Adding Batches, below). They use only the template's tokens. The blue line above a batch's first overview row is what lets the user see the batches at a glance.

```css
/* Batch badges: where each batch starts. */
td.step kbd, .card-title kbd { display: inline-block; margin-left: 0.5rem; padding: 0 0.5rem; border-radius: 999px; font: 500 0.6875rem/1.6 var(--font-mono); letter-spacing: 0.04em; text-transform: uppercase; vertical-align: 0.15em; white-space: nowrap; color: var(--accent); background: var(--accent-soft); border: 1px solid transparent; }
.overview tr:has(> td.step kbd) > td, .overview tr:has(> td.step kbd) > th { border-top: 2px solid var(--accent); }
@media (max-width: 520px) { td.step kbd, .card-title kbd { display: table; margin: 0.25rem 0 0; white-space: normal; letter-spacing: 0; } }
```

## The Section

Under an `<h4>Batches</h4>` subheading: one sentence on how the plan is run ("one fresh session per batch, which reads this plan, runs its steps back to back and stops where you're needed"), one on what the badges mean, then a table:

| Batch | Steps | Where it stops for you |
|---|---|---|
| `1` | `1.1 to 1.2, the repo layout` | `One push to approve` |
| `7` | `9.1, the private merge` | `Nothing to push; a week of everyday use before batch 8 starts` |

Write step numbers as plain text (`1.1 to 1.2`, `Phases 2 to 4`): they become references that follow their steps when the plan renumbers. Add a `.note` after the table for any rule that holds across batches (such as never two sessions writing in the same folder at once).

Then an `<h4>Running a Batch</h4>` subheading, which every batch session follows. Write it for this plan, but keep these parts:

- **What you do:** which folder to start the session in, the words to say ("build the next batch in the <plan title>", or "build batch 4" to pick one), and that the user answers the session's questions and approves its pushes when it stops.
- **What the session does,** as a numbered list:
  1. **Works out which batch.** A batch is done when every step in it is Done or Skipped. The next batch is the lowest-numbered one that isn't done, and it may start only when every batch before it is done. When its row says it waits on something else (a week of use, a review), the session checks that first; if it isn't met, the session says so and stops.
  2. **Reads what the batch needs:** its steps in full, any plan its steps point at, and the skills and project files they name.
  3. **Keeps the plan current as it works:** each step In progress when it starts and Done when it finishes, with an Outcome when what happened differs from the step, and Blocked with the reason when it can't finish. Statuses are how the next session finds its place, so no step is left unmarked.
  4. **Stops only where the table says**, plus anything the session's own instructions say to ask about, and carries on from that step when the user replies.
  5. **Ends at the batch's last step.** It never starts the next batch by itself. Its last message says the batch is done, what it couldn't check, and what's left for the user.
- **Picking up after a break:** if a session ends partway, the next "build the next batch" starts at the first step of that batch that isn't Done.

## Making a Plan with Batches

Write the plan as [making.md](making.md) says, with the badges in the step names (`### Step: Index Recipe Titles <kbd>Batch 1</kbd> {#index-titles}`: give badged steps an `{#id}` so their doc ids don't include the badge), the styles under `## Styles`, the section, and the summary sentence. `plan.py new` puts the styles into the first snapshot.

## Adding Batches to a Plan

On a database plan:

1. Read the plan for context (SKILL.md) to see its steps and its order section.
2. **One message:**
   - `Write` the section's new body to a fragment (the current body with the Batches table and Running a Batch added), unless the plan gets a new Batches section, which goes in an `## Section:` fragment for `--add`.
   - Bash: `plan.py record` with a `--rename` for each badged step (`--rename 2.1 "Make It Stand Alone <kbd>Batch 3</kbd>"`; target badged steps by number, since their names now hold the badge), `--set section:<id> body @<fragment>` (or `--add`), and `--set plan summary "…"` with the summary sentence added.
   - `ArtifactData` `set` of the record, as for any record update.
   - `ArtifactData` `get` of `plan/_plan`, for its version.
3. **One message:** `ArtifactData` `update` of `plan/_plan` with `data` `{"styles": "<the rules above>"}` and that `if_version` (records can't set styles), then a snapshot as [snapshots.md](snapshots.md) says. The styles live in the page's own HTML, so they show once the snapshot republishes it; until then the badges show unstyled.

On an older plan, edit the names, section and summary on the page as [older-plans.md](older-plans.md) says, and put the styles in a `<style>` block marked `/* plan-specific */` straight after the `plan.css` link.

To take batches out, rename the badged steps without their badges, remove the Batches and Running a Batch parts from the section and the sentence from the summary, and set `styles` back to what it was before.

## Building a Batch

When the user asks a session to build the next batch, or a named one: read the plan for context (SKILL.md), with `--show` naming the section that holds Running a Batch and the batch's steps, and follow that subsection. The plan's own text wins over the defaults here, since the user may have changed it for that plan. Mark statuses with record updates as each step starts and ends.
