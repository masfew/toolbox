# Auditing skills

The steps for "audit my skills", "audit the deploy-checklist skill" or "tidy up my release-notes skill": review one skill or every skill in the config's `skill_folders` (or an instruction file, [below](#instruction-files)), apply the clear fixes, and hand the user a list of what needs their decision. The revision workflow keeps each edit clean; an audit catches what was written before this skill existed and the slow drift that many clean edits still add up to.

## One skill

1. **Work out the intended purpose before judging anything.** Read the description, the purpose paragraph, the skill's row in its home's README if it has one, and its first version in git (`git -C <repo> log --diff-filter=A --format=%h -- <skill path>/SKILL.md`, then `git show <hash>:<path>`). Drift is measured against what the skill was meant to do, not against what it says today. If those disagree, the user's latest explicit decision (in the README, a plan or the purpose paragraph) wins; when it's unclear, ask.
2. **Read everything and measure.** The whole `SKILL.md`, every reference file and `evals/`. Run `check_skill.py <folder>` and keep its output as the "before" numbers.
3. **Look for five kinds of problem:**
   - **Bloat:** rules repeated inside the skill, or copied from another skill or the global instructions (the check script's "close copy" lines are a start, not the whole list); long explanations a shorter line says as well; examples that teach nothing the rules don't; history and dated narratives that aren't evidence for a rule; lines a session would get right without them, and emphasis in capitals (house-style.md, Wording); and material in `SKILL.md` that only some tasks need, which belongs in a reference file.
   - **Drift:** sections that serve a different job from the intended purpose, or that belong in a project's `CLAUDE.md` or another skill.
   - **Wrong or misleading:** paths, scripts, commands, tools and function names that don't exist (check each one: `ls`, `grep` the script for the flag, `--help`); rules that contradict another rule, another skill or the global instructions; claims that a file, a test or the current code shows are out of date; and workarounds written for an older model that current ones no longer need (a step that spells out what any session does unprompted).
   - **Description:** whether it matches what the skill does now, follows the house style's description rules (the right kind, every clause earning its place, no inventory), and loads when it should. Run the trigger tests, writing `evals/triggers.json` first if the skill has none, and save the starting score. Compare it with neighbouring descriptions for pairs that claim the same prompts.
   - **Tidiness and tokens:** wording that can be shorter without losing meaning, an order that makes the skill harder to follow, and what the description (every session) and `SKILL.md` (every use) cost in tokens.
4. **Sort what you found into two lists.**
   - **Fix now:** clear fixes that keep every rule's meaning: broken links and paths, a description over the limit or broken, wording made shorter, a copied rule replaced by a pointer to its home, material moved into a reference file, house-style layout.
   - **For the user to decide:** deleting a rule, changing what the skill covers, moving a rule to another skill or a project, and any claim you can't check from files (behaviour of a live service or an application that needs a live test). A rule that looks like bloat is often a trap a session hit once, which is why deleting one needs the user's OK.
5. **Apply the fix-now list through the [Any change](../SKILL.md#any-change) workflow**, so the check script and the trigger tests rerun (asking how to run them first). Respect a home project: outside it, the whole list goes to the user.
6. **Report per skill:** words and estimated tokens before and after (for `SKILL.md` and the description), the trigger score before and after, what was fixed, and the decisions waiting for the user, numbered so they can answer "1 yes, 2 no". Ask the decisions with the question tool (`AskUserQuestion`) when there are four or fewer.

## Every skill

1. **Measure all of them first:** `check_skill.py --all`, so the user sees the whole picture and the order of work (errors first, then the largest skills).
2. **Before reviewing, tell the user how many subagents you'll start, or that you'll review the skills yourself**: one subagent per skill, on a mid-sized model at high effort (reviewing is judgement work, but doesn't need the largest model). Review them yourself only when they're few and small (a few hundred words in all), since each subagent's fresh context then costs more than reading them. Each subagent gets the path to this file, house-style.md and its one skill, and runs steps 1 to 4 above, returning both lists and the before numbers. Subagents report; they don't edit. Edits go through you, one skill at a time, so two never touch the same files and every edit runs the revision workflow.
3. **Ask how to run the trigger tests, once for the whole audit.** Run `run_triggers.py <skill folder> --dry-run` for each skill and put the totals in the question (sessions per tier summed over all the skills, and the time), as [test-tiers.md](test-tiers.md) describes. Each set is dozens of real sessions, so an audit of many skills is the case where the choice matters most; a skipped audit still reports the free numbers. Edit nothing before the answer: each skill's starting score has to come from its unedited description.
4. **Run the trigger tests yourself, one skill at a time**, at the chosen tier. Running several sets at once multiplies the load without making any result faster to act on.
5. **Compare every description in one pass** after the per-skill reviews: list each pair that claims the same kind of prompt, and fix it with a "Not for…" clause on one or both sides, checked with both skills' trigger tests.
6. **Apply and report** as in steps 5 and 6 above, one skill at a time, then a short summary across all of them: total description characters before and after, skills over budget before and after, and the full list of decisions waiting.

## Instruction files

For "audit my global instructions", "clean up this project's CLAUDE.md" or "audit all my CLAUDE.md files". The steps for one skill apply, with these differences:

1. **Purpose:** the file's first version in git (or the project README when the project isn't in git) and the sections' names. The global instructions' purpose is rules every session needs; a project file's is what sessions in that project must know.
2. **Measure** with `check_instructions.py <file>`, or `--all` for every file. Run the tests of a section that has them (`evals/<slug>/`) only when you'll change that section, after asking how to run them.
3. **The five kinds of problem**, read for these files: bloat includes rules restated from a skill or the global instructions, and dated history; drift is a global section only one kind of work needs, or a project rule general enough for a skill; wrong includes renamed skills, tools and paths (the check catches some) and rules the current code or setup contradicts. Contradictions between the global instructions, project files and skills are the most damaging find, since a session can follow either one. Description problems don't apply.
4. **Fix now and the user's list** split as for skills. Moving a section between the global instructions and a skill is always the user's decision, as is any change to a section with tests.
5. **For all of them**, one subagent per file as in Every skill step 2, then one pass comparing the global instructions with every project file for restated or contradicting rules.

## Afterwards

When an audit finds a kind of problem the check script could have caught, or a house-style rule that didn't hold up, suggest the change to instruction-manager itself (its Improving This Skill section).
