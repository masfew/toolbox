# Tuning a description

Read this when a description has to be written or fixed against its trigger tests: New skill step 7, a lower score in Any change step 6, or an audit's description fixes. Ask how to test once, before the first run of the task ([test-tiers.md](test-tiers.md)); the answer covers every run below.

1. **Run the whole `evals/triggers.json`** against the current description. Each failed prompt shows what loaded instead.
2. **Hold some prompts out.** Copy about 40% of them, should-load and near-miss in the same proportion as the whole file, to a scratch file, and the rest to another. Tune only on the rest (`--eval-set <the rest>`), and don't read why a held-out prompt failed. A description fitted to the prompts it was tuned on passes them and generalises to nothing; the held-out ones show whether it generalises.
3. **For each failure in the tuning set**, work out the situation the description doesn't cover, or the neighbour it collides with. Write two or three candidates that cover the situation in general words, following house-style.md's Description section. Never paste a test prompt's own wording into the description, for the same reason as step 2.
4. **Run each candidate** with `--description "…" --eval-set <the rest>`. With Quick, every run is `--tier quick`; with Standard or Full, these draft runs use `--runs 1` on the default model. Prefer the higher score; on a tie, the shorter description, since every session pays for it.
5. **If a near-miss belongs to a neighbouring skill** and keeps loading this one, sharpen the "Not for…" clause naming that neighbour, and check the neighbour's description doesn't claim the prompt too.
6. **Pick the winner** from the best one or two by their score on the held-out prompts (`--eval-set <held out>`), at the chosen tier. Stop after about five rounds of steps 3 to 6: further rounds fit the tuning prompts, not the skill.
7. **Trim the winner**, since nothing else shortens a passing description: cut the clause least likely to earn its place (house-style.md, Description), run it as step 4 runs a draft, and keep the cut if the score holds. Stop at the first cut that lowers it, or after three.
8. **Write the winner into `SKILL.md`**, then run the whole `triggers.json` at the chosen tier with `--compare --save`. Save only whole-file runs: a score on part of the prompts isn't comparable with the last one.
