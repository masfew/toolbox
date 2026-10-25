# Building Selected Phases

Read when the user asks a session to build the selected (ticked) phases of a plan ("build the selected phases in the <plan>", "build what I ticked"), or to build two or more named phases in one session. Database plans only: an older plan (no `plan/_plan`) has no tick boxes, so build its named phases one after another as [older-plans.md](older-plans.md) says. A plan's batches keep their own Running a Batch rules ([batches.md](batches.md)), and their core phases can't be ticked.

## How Ticks and Claims Work

The plan overview has a tick box in the phase cell of every planned feature that isn't finished or waiting to be reset, and of every unfinished core phase when the plan has no batches. Only the owner and editors see them. Ticking saves straight away to one document, `features/_build`: `{"phases": {"<phase doc id>": {"state": "selected" | "claimed", "at": "…", "by": "…"}}}`. It's keyed by doc id, so a tick stays with its phase when the plan renumbers, and the order of the ticks isn't kept: only dependencies decide the build order.

A session **claims** every ticked phase in one `update` pinned to the version it listed, before it builds anything. If anything changed in between (another session's claim, a new tick), the write fails and the session reads again, so two sessions never build the same phase. A claimed phase shows "Claimed", the session's name and time, and a Release button in place of its box until it's finished.

## Steps

1. **One message:** Artifact `open` with the plan's `url`, `ArtifactData` `list` of collections `plan`, `statuses` and `features`, each with `out_dir` `<scratchpad>/plan/db` and `query: {"limit": 1000}`, then Bash `python -I <skill folder>/plan.py build <scratchpad>/plan/db`. Keep the `features` list result: it shows `_build`'s `version`. The report lists each ticked phase in a suggested order, with its steps, its steps' Depends On text, and the other unfinished phases its text mentions (marked ticked, claimed or NOT ticked), then the phases other sessions have claimed.
   - Nothing ticked, and the user named no phases: say so and stop.
   - Named phases ("build F8 and F10"): they're claimed with `--take F8 F10` in step 2, ticked or not.
2. **Check the dependencies, then claim.** Mentions are hints: read each ticked phase's text and judge which are real dependencies. When a phase depends on unfinished work that's neither ticked nor claimed by this session, ask the user before claiming anything (tick it too, build without it, or leave that phase out). Never build a phase another session has claimed. Then **one message**:
   - Bash: `python -I <skill folder>/plan.py build <scratchpad>/plan/db --claim "<name>" --out <scratchpad>/claim.json` (plus `--take …` for named phases). The name is what the page shows: this session's title if you can get it (in the Claude desktop app, `get_session` with `"self"`), else the plan's topic and today's date. It claims every ticked phase and clears entries for phases that are finished or gone.
   - `ArtifactData` `update` of `features/_build` with `file_path` `<scratchpad>/claim.json` and `if_version` from the list. With no `_build` document yet (named phases on a plan nobody ticked), `set` it instead, with no `if_version`.
   - If the update is refused because the version changed, list `features` again, rerun `build`, and claim what's still yours to take.
3. **Build them**, in the order the dependencies set (the report's suggested order unless the text says otherwise). With one phase, build it yourself as any plan step is built. With two or more, this session is the **orchestrator** ([below](#the-orchestrator)).
4. **Finish.** When every claimed phase is done, or the session stops early: one message `ArtifactData` `list` of `features` (`out_dir` as before, so `_build`'s version is current), then one message Bash `plan.py build <scratchpad>/plan/db --release [PHASE …] --out <scratchpad>/release.json` and the `update` of `features/_build` pinned to that version. With no phases named, it clears every finished phase's entry; name the claimed phases you didn't finish, since the next session can only take them once they're released. Then reply: the phases built, what's left, and what you couldn't check.

## The Orchestrator

The orchestrator never builds a phase itself. It hands each phase to a worker subagent, checks what comes back, and is the only one that reads or writes the plan.

- **One worker at a time.** Phases in one project usually touch the same files, so the default is one worker, one phase, in order. Run two at once only when they clearly can't collide (separate programs or folders, neither needing the other's result), and never two workers in the same files.
- **Model and effort:** choose each worker's model and effort as your instructions say for subagents. Building a phase is design and coding work.
- **Before a worker starts:** mark the phase's first unfinished step In progress with a record update (SKILL.md), and in the same message write the worker's phase text with `python -I <skill folder>/plan.py build <scratchpad>/plan/db --brief <phase> --out <scratchpad>/<phase>.md` (it holds the phase's unfinished steps in full and its finished ones by name).
- **The worker's brief** is small, since the plan already holds the detail: the project folder; the path of its phase file and that it builds only that phase; the project's README and `CLAUDE.md` to read first; a few lines on what earlier phases changed that this one needs (not their history); the skills it needs; that it never reads or changes the plan, commits or pushes unless told; and that it stops and reports instead of guessing whenever it needs the user (a decision, an approval, a hands-on check, a push). It ends its run with this report and nothing longer:

  ```
  Status: done | needs the user | blocked
  Steps: each step's number, done or not, one line each
  Changed: the files
  Checked: what it ran or looked at, and the result
  Needs: the question for the user, or what blocks it
  For later phases: anything the next phases must know
  ```
- **When a worker needs the user:** ask the user its question in full (with the context it gave), then send their answer back to the same worker with `SendMessage`, so it keeps its context. Don't start a new worker for the same phase.
- **Check before marking done.** A worker's report sounds equally sure whether or not the work is right. Run the tests or read the diff yourself; if something's wrong or missing, send that worker back with what to fix. Then mark the phase's steps done in one record update, with an Outcome where what happened differs from the step, or Blocked with the reason.
- **Between phases,** carry forward only the "For later phases" lines the next phases need.
- **Commits** follow the user's and the project's own rules, made by the orchestrator, never by workers.
- **Stopping early** (the user says stop, or a phase is blocked and the rest depend on it): finish as step 4 says, releasing every claimed phase you won't finish.

## Picking Up After a Break

A phase stays claimed after its session ends until it's finished or released. When the user wants a new session to carry on with phases an earlier session claimed but didn't finish, they press Release on each (or ask you to release them: `--release F8 F10`, as in step 4), then tick them again or name them.
