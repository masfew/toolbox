# Light plans

A light plan is one Markdown file per session that is both the session's plan and its saved state. It's for Claude, not for reading on a page: terse, no HTML, never an Artifact. Its job is to make `/clear` safe, so the user can clear at a break point (a feature lands, a phase ends) instead of letting the session compact. Compacting re-reads the whole context to write a summary, one of the most expensive requests a session makes; `/clear` costs nothing, and the resume hook pastes the light plan back in afterwards.

## When to make one

- **The user asks** for a light or lightweight plan, a session plan, session notes, or to save state.
- **Unprompted**, once the session does work with 3 or more steps that change files, or work likely to outlast one context. Never for questions, single edits or reads. Say so in one line when you make it ("Started a light plan for this session.").
- "Make a plan" on its own always means a full Artifact plan ([making.md](making.md)), never a light one.
- One light plan per session, for that session's task. A different task gets a new session; a light plan is never carried into another session.

## Where it lives

`%APPDATA%\Claude\side-session-notes\<session id>\session-plan.md`, where the session id is the desktop app's `local_…` id. It stays the same across `/clear`, and hooks read it from the environment variable `CLAUDE_CODE_HOST_SESSION_ID`. Get the full path in one call, in the same message as other calls. Bash (Git Bash; a backslash before `$` would stop the id expanding):

```bash
cygpath -w "$APPDATA/Claude/side-session-notes/$CLAUDE_CODE_HOST_SESSION_ID/session-plan.md"
```

PowerShell: `"$env:APPDATA\Claude\side-session-notes\$env:CLAUDE_CODE_HOST_SESSION_ID\session-plan.md"`.

Write, Read and Edit use that path as it is (Write makes the folder). If the variable is empty, the session isn't in the desktop app and no hook can find the file after `/clear`: don't make one unprompted, and if asked, tell the user they'll need to point Claude at it after clearing.

The app is a packaged Windows app, so that folder is really under `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude\`. Claude's own tools see the Roaming path; Python run from Bash doesn't and needs the LocalCache path. Files there not changed for 14 days are deleted by the hook.

## The file

```markdown
# Title in Title Case

Light plan · created 2026-10-20 · updated 2026-10-20 · status: building
Resume: read this whole file, then continue from Current State. Update it at every finished step and before any /clear.

## Goal
What the session is for and what done looks like. Two to five lines.

## Current State
- Where the work stands right now and the very next action. Overwrite, never append: no history here.

## Decisions
Made:
- A decision and its reason, one line each.
Open:
- A question waiting on the user, or "None".

## Plan

## Phase: Name {#id}

### Step: Name [todo] {#id}
- What to do, where, and what done looks like, as short bullets.

## Key Files
- `path`: what's there that matters.

## Dead Ends
- Tried X, failed because Y.

## Notes and Traps
- Constraints, gotchas, user preferences for this task.

## Log
- 2026-10-20: One line per milestone.
```

- Statuses: `todo`, `progress`, `done`, `blocked`, `skipped`. Headings in title case, as in full plans. Phases are optional for a short plan: steps can sit straight under `## Plan`.
- Step headings use the full plan source's form (`## Phase:`, `### Step: Name [status] {#id}`) so the file can be promoted. Step bodies are plain Markdown bullets.
- Keep it under about 100 lines once work starts. A finished step shrinks to its heading and one `- Outcome:` line. A planning-stage file may run longer while the steps hold the most detail.

## What to keep and what to prune

- **Keep:** decisions made and why, constraints, open tasks, key file paths, unresolved bugs, dead ends ("tried X, failed because Y", so a resumed session doesn't retry them), anything the user said that the code doesn't show.
- **Prune:** detail of finished steps (down to one line), reversed decisions, exploration notes once they've led to an answer. Prune only at milestones, never mid-task. A bad prune fails silently, since you can't know what the user will ask next.

## Updating it

- Update at milestones: a step finished, a decision made, a dead end found, and when the user says "save state" or is about to `/clear`. Not every turn.
- Each update is a small `Edit` in place, sent in the same message as other tool calls, so it rarely adds a round trip. Bump the `updated` date. History goes only in the one-line Log.
- After a milestone in a long session, bring the file up to date and say in one line that it's current and this is a good point to `/clear`. Do the same when the user says they're stepping away: after an hour idle the prompt cache expires and the first message back re-sends everything at full price.

## Resuming

After `/clear` or a compaction, the hook pastes the file into the new context with its path. (In the desktop app `/clear` starts a fresh process that reports a normal startup, so the hook also restores on startup when the session already has a light plan.) Then:

- Trust Current State and continue from it without being told.
- Before acting on anything that names a file, function or setting, check it still exists.
- If a detail you need is missing, search this session's transcripts on disk (`~/.claude/projects/<project>/*.jsonl`, or the session tools' transcript search) before asking the user.

## Promoting to a full plan

When the user asks to make a light plan a full plan: read the light file, write a plan source per [making.md](making.md) (the steps' bullets become `<h5>` What / How / Why details, the statuses carry over, Goal becomes the summary, Decisions and Notes can become sections), publish it as a new plan, then add the Artifact link to the light file's header. Keep the light file as the session's state; the Artifact is now the plan.
