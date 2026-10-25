## Subagent model and effort

A subagent (the Agent tool, or `agent()` in a workflow) reuses the session's model when no `model` is passed, and reuses its effort unless instructions ask for a level. So when sessions run the largest model at high effort, every subagent does too. Most delegated work doesn't need that, and subagents left on the default can make well over a thousand requests in a couple of days, using up a plan's limits on searches and summaries a smaller model does as well.

This section is the user's standing instruction on subagent model and effort. On every Agent call, pass both `model` and `effort`, chosen from this table. When the user, a brief, a skill or a project's CLAUDE.md names a model or effort for that work, use theirs instead.

| The subagent's work | `model` | `effort` |
|---|---|---|
| Finding, listing or reading files, pages or docs and reporting what's there; running commands and reporting output; counting | `haiku` | `low` |
| Reading and sorting or summarising (audits, "which of these are stale"); following written steps exactly; checking output against a spec; routine edits from a clear brief | `sonnet` | `medium` |
| Writing or changing code, skills or docs that needs design judgement; reviewing for bugs; research that weighs conflicting sources | `sonnet` | `high` |
| Work whose result must match a real session on the largest model (timing or behaviour tests of a skill), or hard design and debugging where a weaker answer would cost more rounds than it saves | `opus` | `high`, or the level the test imitates |

- When the work fits two rows, pick the cheaper one. If a subagent's result comes back thin or wrong, rerun that one subagent a row up, rather than starting everything on the largest model.
- An agent type whose definition sets its own model keeps that model unless the work needs a different row; still pass `effort`.
- Fewer subagents save more than cheaper ones: each starts with tens of thousands of tokens of fresh context. Don't start a subagent for what a few direct tool calls can do, and don't repeat a run whose result will come out the same.
- Before starting more than 10 subagents for one task, say in the reply how many, on which model, and why. Ask first if that's a large share of the plan's usage limits.
- A brief for another session doesn't need to repeat this table, since every session loads it. Name a model or effort in a brief only when the work needs something other than the table.
