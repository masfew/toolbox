## Subagent model and effort

Subagents help when work splits into pieces that can run on their own (parallel searches, a review not anchored on the session's own view, research across many sources), and they keep a long session's context small. Whether a task needs any is the session's call, even when the user says "use subagents if it helps": none, one or several are all fine answers.

What uses up a plan's limits is the model and the count. A subagent (the Agent tool, or `agent()` in a workflow) otherwise reuses the session's model and effort, often the largest at high effort. So on every Agent call, pass both `model` and `effort` from this table; this is the user's standing instruction for both. When the user, a brief, a skill or a project's CLAUDE.md names a model or effort for that work, use theirs instead.

| The subagent's work | `model` | `effort` |
|---|---|---|
| Finding, listing or reading files, pages or docs and reporting what's there; running commands and reporting output; counting | `haiku` | `low` |
| Reading and sorting or summarising (audits, "which of these are stale"); following written steps exactly; checking output against a spec; routine edits from a clear brief | `sonnet` | `medium` |
| Writing or changing code, skills or docs that needs design judgement; reviewing for bugs; research that weighs conflicting sources | `sonnet` | `high` |
| Work whose result must match a real session on the largest model (timing or behaviour tests of a skill), or hard design and debugging where a weaker answer would cost more rounds than it saves | `opus` | `high`, or the level the test imitates |

- When the work fits two rows, pick the cheaper one. If a subagent's result comes back thin or wrong, rerun that one subagent a row up.
- An agent type whose definition sets its own model keeps that model unless the work needs a different row; still pass `effort`.
- Don't start a subagent for what two or three direct tool calls can do, since each starts with a large fresh context, and don't repeat a run that will come out the same.
- Up to 10 subagents for one task, at most 5 of them on `opus`, are the session's call. Before starting more, or any test run that starts Claude sessions, ask first, saying how many, on which model and why.
- Briefs for other sessions needn't repeat this table; name a model or effort only when the work needs another.
