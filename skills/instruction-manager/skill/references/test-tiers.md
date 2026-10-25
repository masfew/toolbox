# Test tiers

How to test a skill or an instruction section without surprising the user with a bill. Every trigger run, behaviour test and section test starts real Claude sessions, and those count against the plan's usage limits. A run that is trivial on a large plan can use up a smaller plan's limit, and the skill can't see which plan the user has. So it asks, every time, before the first run of a task. The free checks (`check_skill.py`, `check_instructions.py`) never need this.

## The tiers

| Tier | Flag | Model | Runs per prompt | Early stop | Sessions per prompt | Catches | Suits |
|---|---|---|---|---|---|---|---|
| Quick | `--tier quick` | Haiku | 1 | n/a | about 1 | A broken or badly worded description; a skill that stopped loading, or loads for everything | Any plan, including the smallest |
| Standard | `--tier standard` | The CLI's default model | up to 3 | Yes: a prompt stops once its result is settled | 2 to 3 | Quick's failures plus small shifts in how often the skill loads, on the model sessions actually use | Larger plans (Max 5x and 20x). On a small plan it can use a lot of the limit |
| Full | `--tier full` | Opus | 3 | No | 3, plus the behaviour tests | Everything Standard catches, on the strongest model, and whether the skill's output follows its rules | Larger plans only, for a big rewrite or a new skill |

`--runs` and `--model` without `--tier` make a **custom** run: the script runs exactly that, and it is only compared against an earlier custom run with the same model and runs.

**Behaviour tests** (`evals.json`, see house-style.md, Tests) belong to Full. Quick and Standard run trigger tests only. Run each behaviour prompt in a subagent on Opus told to follow the skill, grade the output against the expectations, and fix the skill where it fails.

## The question

Ask with the question tool when there is one. Put the context in the text **above** the question, in the same message:

- what changed (the files and the kind of change),
- that each option starts real Claude sessions that count against the plan's usage limits,
- that the free checks passed (`check_skill.py` or `check_instructions.py`, with the result).

Then ask **"How should I test this change?"** with these options, in this order (cheapest first, so nobody picks the top one out of habit). Mark the recommended one with "(Recommended)" and leave it where it is.

- **Quick:** about N short sessions on Haiku, about M minutes. Fine on any plan, including Pro. Catches a broken description, but not small shifts in how often the skill loads.
- **Standard:** about N to M short sessions on your default model, about T minutes. Good for Max 5x and 20x. On Pro it can use a lot of your limit.
- **Full:** about N sessions on Opus plus the behaviour tests, about T minutes plus the tests. Only on Max 5x or 20x, and only for a big rewrite.
- **Skip testing:** no sessions. The change goes in without being tested (the check script will keep warning that the description changed since its last trigger run).

Without a question tool, put the same four options in a numbered list at the end of the reply, with the recommendation, so the user can answer "2". Never start sessions before the answer comes back.

**Which to recommend** follows the size of the change, not a guess about the plan: a small edit recommends Quick, a changed description or rule recommends Standard, and a big rewrite or a new skill recommends Full. An edit that touches neither the description nor a tested rule (a typo, a link) runs no test, so there is nothing to ask. Always show all four options so the user can choose another.

## Filling in the numbers

Run `python -I <skill folder>/scripts/run_triggers.py <skill folder> --dry-run` for the skill being tested. It prints, for each tier, the number of sessions for this skill's `triggers.json`, the model and an estimated time, and starts nothing. Put those figures in N, M and T; don't invent them. Quick's N is about one session per prompt; Standard's range runs from 2 sessions per prompt (the first two runs agree) to 3 (they disagree); Full's is 3 per prompt. For an audit or any task with several skills, run it for each skill and give the totals.

## Other places that ask

- **Tuning a description** runs many candidates. Ask once before the first run of the task; the answer covers the whole loop. Quick means `--tier quick` for every run, drafts included. Standard and Full mean `--runs 1` on the default model for drafting candidates, then the chosen tier for the one or two finalists. Say that in the question's text, with the totals for both stages.
- **Auditing all skills** asks once for the whole audit, with the totals across skills (audit.md, Every skill).
- **An instruction section's tests** (`evals/<section>/` beside the file) ask the same way. Use the options and costs in that folder's README, with the free checks passed as the context above the question. When the README gives none, ask "Run it (about N sessions) / Skip testing", with N from the README or the number of test prompts.
- **The user's own `CLAUDE.md`** may set a standing answer ("always run Standard on my skills"). That wins; follow it and say in one line which tier you ran and why.

## What's recorded

`last-run.json` keeps the latest run at the top level and the latest run of each tier under `tiers`. Each entry has the date, a hash of the description tested, the `tier` (or `custom`), the `model`, runs per query, the `seconds` it took, passed and total, and the failed queries. A file written before tiers existed is read as a Standard run.

`--compare` compares only against the latest run **of the same tier**: a Quick score and a Full score measure different things, so a Quick run never "drops" against a Full one. A custom run compares only against a custom run with the same model and runs. With no earlier run of that tier, the script says so and does not fail; the first `--save` of a tier sets the baseline. After a Skip testing, nothing is saved, and the next full check warns that the description changed since the last run.
