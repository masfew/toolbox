"""scen.py [SKILLDIR DBDIR] (defaults ../skill and sample-db): every record kind on a copy of a listed plan (plan/, statuses/), checked through the model,
the page builder and the fold. Prints PASS/FAIL per scenario."""
import copy, json, re, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE.parent / "skill"
BASE = Path(sys.argv[2]) if len(sys.argv) > 2 else HERE / "sample-db"
sys.path.insert(0, str(SKILL))
import dbplan as db  # noqa: E402

plan0, st0, fe0 = db.load_dir(BASE)
results = []


def run(*args):
    p = subprocess.run([sys.executable, "-I", str(SKILL / "plan.py"), *map(str, args)], capture_output=True, text=True, encoding="utf-8")
    if p.returncode:
        raise SystemExit(f"plan.py {' '.join(map(str, args))} failed: {p.stderr or p.stdout}")
    return p.stdout


tmp = Path(tempfile.mkdtemp())
seq = [0]


def rec_of(*args):
    """A record from plan.py record."""
    seq[0] += 1
    f = tmp / f"r{seq[0]}.json"
    run("record", f, *args)
    r = json.loads(f.read_text(encoding="utf-8"))
    return r


def with_records(*recs, plan=None):
    sts = dict(st0)
    for i, r in enumerate(recs):
        r = dict(r)
        r["at"] = f"2030-01-01T00:00:{i:02d}.000Z"
        sts[f"r-test-{i:02d}"] = r
    m = db.Model(plan or plan0, sts, fe0)
    CASES.append((plan or plan0, sts))
    return m


CASES = []


def check(name, cond, detail=""):
    results.append((name, bool(cond), detail))


def unbake(html):
    return re.sub(r' data-baked="[^"]*"', '', html)


def steps(m):
    return {m.num_of[s]: (db.text_of(m.sub(v["name"])), m.status[s]) for lst in m.steps.values() for s, v in lst}


m0 = db.Model(plan0, st0, fe0)
s0 = steps(m0)
page0 = db.build_content(m0)

# 1 status by number
m = with_records(rec_of("F7.1=done"))
check("status", steps(m)["F7.1"][1] == "done" and m.version == "9.2")

# 2 rename + swaps (hit, under, miss)
r = rec_of("--rename", "4.2", "Fast Search for Recent Meals", "--swap", "4.2:What", "recipes", "meals",
           "--swap", "4.2", "no such words here", "x")
m = with_records(r)
body = m.sub(m.E[m.id_of["4.2"]]["body"])
what = body[body.find("<h5>What</h5>"):]
what = what[:what.find("<h5>", 5)]
check("rename+swap", steps(m)["4.2"][0] == "Fast Search for Recent Meals" and "recipes" not in what and "meals" in what
      and len(m.misses) == 1 and "no such words" in m.misses[0], m.misses)

# 3 add a step at the end of F7 by number, then a later record marks it by its new number
src = tmp / "add.txt"
src.write_text("### Step: Keep Leftovers After a Crash {#restore-kept}\n<h5>What</h5>\n<p>Keep the leftovers list after "
               "a crash. Builds on F7.2 and 4.3.</p>\n", encoding="utf-8")
r1 = rec_of("--add", src, "--phase", "F7")
r2 = rec_of("F7.3=progress")
m = with_records(r1, r2)
st = steps(m)
nb = m.E["s-restore-kept"]["body"]
check("add step end of phase", st.get("F7.3") == ("Keep Leftovers After a Crash", "progress") and m.version == "10.1"
      and "{{S:s-suggest-meals-from-leftovers}}" in nb and "{{S:s-crash-recovery}}" in nb, (st.get("F7.3"), nb))

# 4 move F8 before F7 when told, then F7.1 means Settings Menu's first step
r1 = rec_of("--move", "F8", "before", "F7")
r2 = rec_of("F7.1=done", "--note", "F8.1", "Kept list note.")
m = with_records(r1, r2)
st = steps(m)
check("move", m.fnum["settings-menu"] == "F7" and st["F7.1"] == (s0["F8.1"][0], "done") and st["F8.1"] == s0["F7.1"]
      and m.notes.get("s-keep-list-at-meal-end") == ["<p>Kept list note.</p>"], (st["F7.1"], m.notes))

# 4b move by names, as the user says them
m = with_records(rec_of("--move", "Settings Menu", "before", "Leftovers"))
check("move by name", m.fnum["settings-menu"] == "F7" and m.fnum["leftovers"] == "F8")

# 5 a mention of F7.2 in text follows its step after the move
txt = m.sub(m.E["s-keep-list-at-meal-end"]["body"])
check("mention follows", "F8.2 follows" in txt, re.findall(r"F\d\.\d follows", txt))

# 6 drag (order) as the page writes it
m = with_records({"steps": {}, "date": "2030-01-01", "major": True, "order": ["settings-menu", "leftovers"]})
check("order", m.fnum["settings-menu"] == "F7" and m.fnum["leftovers"] == "F8" and m.version == "10.0")

# 7 accept and plan an idea + take out + idea edit, in one record (selections)
src = tmp / "plan.txt"
src.write_text("## Feature: Recipe Search | Search {#recipe-search}\nA search box over the recipe list.\n\n"
               "### Step: Search Box {#search-box-2}\n<h5>What</h5>\n<p>A box.</p>\n", encoding="utf-8")
idea = tmp / "idea.txt"
idea.write_text("## Idea: Recipe Search {#recipe-search}\nFind a recipe by its title.\n", encoding="utf-8")
m1 = with_records(rec_of("--add", idea))
check("add idea", any(k == "i-recipe-search" for k, _ in m1.ideas) and m1.version == "9.2")
r1 = rec_of("--add", idea)
r2 = rec_of("--add", src, "--set", "idea:recipe-search", "name", "Ignored Because Planned", "--takeout", "settings-menu")
m = with_records(r1, r2)
check("plan+takeout", m.fnum.get("recipe-search") == "F8" and "settings-menu" not in m.fnum
      and not any(k == "i-recipe-search" for k, _ in m.ideas) and any(k == "i-settings-menu" for k, _ in m.ideas)
      and steps(m).get("F8.1") == ("Search Box", "todo") and m.version == "10.0", (m.fnum, [k for k, _ in m.ideas]))

# 8 set on the plan summary and a section
r = rec_of("--set", "plan", "summary", "A new summary mentioning 3.6.", "--set", "section:risks", "name", "Risks")
m = with_records(r)
check("set", m.sub(m.M["summary"]) == "A new summary mentioning 3.6." and "{{S:s-health-check}}" in m.M["summary"]
      and m.sub(dict(m.sections)["x-risks"]["name"]) == "Risks")

# 9 replay is idempotent over folded entries, and a finished fold changes nothing shown (on a plan that already sorts
# by status: the snapshot that turns the sort on reorders, see 20)
sorted_plan = copy.deepcopy(plan0)
sorted_plan["_plan"]["statusOrder"] = True
r1 = rec_of("--add", src.parent / "add.txt", "--phase", "F7")
r2 = rec_of("F7.3=done", "--outcome", "F7.3", "Done on the day.", "--swap", "F7.1", "Build this first", "Build this one first",
            "--rename", "F8", "Settings")
r3 = rec_of("--move", "F8", "before", "F7")
m = with_records(r1, r2, r3, plan=sorted_plan)
page = db.build_content(m)
F, meta = db.folded(m)
fold = db.fold_record(m, F, meta)
writes = db.entry_writes(m, F)
# (1) only the fold record written
fr = dict(fold); fr["at"] = "2030-01-01T00:00:09.000Z"; meta["bakedAt"] = fr["at"]
m1 = with_records(r1, r2, r3, plan=sorted_plan)
sts = dict(m1.statuses); sts["r-test-fold"] = fr
m_a = db.Model(sorted_plan, sts, fe0)
check("fold: record only", unbake(db.build_content(m_a)) == unbake(page) and m_a.version == m.version, (m_a.version, m_a.misses))
# (2) entries half written
plan_f = copy.deepcopy(sorted_plan)
for op, k, body in writes[: len(writes) // 2]:
    if op == "set": plan_f[k] = body
    else: plan_f.pop(k, None)
m_b = db.Model(plan_f, sts, fe0)
check("fold: half the entries", unbake(db.build_content(m_b)) == unbake(page), m_b.misses)
for op, k, body in writes:
    if op == "set": plan_f[k] = body
    else: plan_f.pop(k, None)
# (3) _plan written; records still there
plan_f["_plan"] = meta
m_c = db.Model(plan_f, sts, fe0)
check("fold: _plan written", unbake(db.build_content(m_c)) == unbake(page) and m_c.version == m.version and not m_c.records)
# (4) records deleted
m_d = db.Model(plan_f, {k: v for k, v in sts.items() if k.startswith("_")}, fe0)
check("fold: done", unbake(db.build_content(m_d)) == unbake(page), (m_d.version,))

# 10 seeds: the same plan as one _seed document builds the same page; an own document wins over the seed
entries = {k: v for k, v in plan0.items()}
seeded = db.seed_docs(entries)
ms = db.Model(seeded, st0, fe0)
check("seed", db.build_content(ms) == page0)
seeded2 = dict(seeded)
seeded2["s-recipe-files"] = dict(plan0["s-recipe-files"], name="Own Doc Wins")
seeded2["x-risks"] = {"deleted": True}
ms2 = db.Model(seeded2, st0, fe0)
check("seed overlay", steps(ms2)["1.1"][0] == "Own Doc Wins" and "x-risks" not in dict(ms2.sections))

# 11 tokenizer rules
m = m0
t = m.tokenize("<p>See 3.6 and F7.2, F8, steps 3.2 and 3.6 (3.6). Not 1.5 days, v3.6, version 3.6, 3.6 s, 3.6x, "
               "1.0 → 1.1, 3.6.1, <code>3.6</code>, F12 key.</p>")
want = ("<p>See {{S:s-health-check}} and {{S:s-suggest-meals-from-leftovers}}, {{F:settings-menu}}, steps "
        "{{S:s-live-counts}} and {{S:s-health-check}} ({{S:s-health-check}}). Not 1.5 days, v3.6, version 3.6, 3.6 s, "
        "3.6x, 1.0 → 1.1, 3.6.1, <code>3.6</code>, F12 key.</p>")
check("tokenize", t == want, t)

# 12 allowlist check
bad = db.check_html('<p onclick="x()">a <img src=x> <a href="javascript:alert(1)">b</a> <span class="evil">c</span></p>')
check("allowlist", len(bad) == 4, bad)

# 13 checkpoint records (Phase 1) still replay: structural changes before the last checkpoint are in the entries
cp = {"steps": {}, "date": "2030-01-01", "major": True,
      "checkpoint": {"steps": {"s-keep-list-at-meal-end": "progress"}, "notes": {}}}
m = with_records(rec_of("--rename", "F7", "Old Rename"), cp, rec_of("F7.2=done"))
check("checkpoint", steps(m)["F7.1"][1] == "progress" and steps(m)["F7.2"][1] == "done"
      and db.text_of(m.sub(m.E["p-leftovers"]["name"])) == "Leftovers")

# 14 edit and add with a listed plan name entries by id
out = tmp / "w"
run("edit", BASE, "4.2", "--out", out, "--replace", "recipes", "meals", "--in", "What", "--name", "Fast Meals")
r = json.loads((out / "record.json").read_text(encoding="utf-8"))
m = with_records(r)
check("edit", "s-fast-search-for-recent-recipes" in r["set"] and steps(m)["4.2"][0] == "Fast Meals")
run("add", src.parent / "add.txt", "--db", BASE, "--after", "F7.1", "--out", out)
r = json.loads((out / "record.json").read_text(encoding="utf-8"))
m = with_records(r)
check("add after", r["add"][0]["after"] == "s-keep-list-at-meal-end" and steps(m)["F7.2"][0].startswith("Keep Leftovers")
      and steps(m)["F7.3"] == s0["F7.2"])
run("move", BASE, "4.3", "--before", "4.1", "--out", out)
r = json.loads((out / "record.json").read_text(encoding="utf-8"))
m = with_records(r)
check("move by id", steps(m)["4.1"] == s0["4.3"])

# 15 an add whose text names its own steps (numbers the plan doesn't have yet), then a drag puts it first;
# a later add mid-phase still reads numbers the plan had as they stood before it
own = tmp / "own.txt"
own.write_text("## Feature: Recipe Search | Search {#recipe-search}\nTwo steps: F9.1 builds the box, F9.2 ranks.\n\n"
               "### Step: Search Box {#search-box}\n<h5>What</h5>\n<p>Results come in F9.2; builds on F7.1 and 4.3.</p>\n\n"
               "### Step: Ranking {#ranking}\n<h5>What</h5>\n<p>Ranks what F9.1 finds.</p>\n", encoding="utf-8")
mid = tmp / "mid.txt"
mid.write_text("### Step: Kept Note {#kept-note}\n<h5>What</h5>\n<p>Comes before F8.2.</p>\n", encoding="utf-8")
r1 = rec_of("--add", own)
r2 = {"steps": {}, "date": "2030-01-01", "major": True, "order": ["recipe-search", "leftovers", "settings-menu"]}
r3 = rec_of("--add", mid, "--after", "F8.1")
m = with_records(r1, r2, r3)
desc = m.sub(m.E["p-recipe-search"]["desc"])
box, rank = m.sub(m.E["s-search-box"]["body"]), m.sub(m.E["s-ranking"]["body"])
note = m.sub(m.E["s-kept-note"]["body"])
check("add names own steps", m.fnum["recipe-search"] == "F7" and "F7.1 builds the box, F7.2 ranks" in desc
      and "Results come in F7.2; builds on F8.1 and 4.3." in box and "Ranks what F7.1 finds." in rank
      and "{{S:s-ranking}}" in m.E["s-search-box"]["body"] and "{{F:" not in desc
      and steps(m)["F8.2"][0] == "Kept Note" and "Comes before F8.3." in note, (desc, box, rank, note))

# 16 a snapshot Claude saves (snapshot --fold) drops the page's "saved automatically" flag from _plan
import shutil
auto_db = tmp / "auto-db"
shutil.copytree(BASE, auto_db)
meta0 = json.loads((auto_db / "plan" / "_plan.json").read_text(encoding="utf-8"))
meta0.update({"snapshotAuto": True, "snapshotAt": "2026-10-18T10:00:00Z"})
(auto_db / "plan" / "_plan.json").write_text(json.dumps(meta0), encoding="utf-8")
(auto_db / "statuses" / "r-20261020-1.1-done-auto.json").write_text(json.dumps(rec_of("1.1=done")), encoding="utf-8")
run("snapshot", auto_db, "--out", tmp / "auto.html", "--fold", tmp / "auto-fold")
meta1 = json.loads((tmp / "auto-fold" / "_plan.json").read_text(encoding="utf-8"))
check("fold clears snapshotAuto", "snapshotAuto" not in meta1 and meta1["snapshotAt"] == meta1["bakedAt"] > meta0["snapshotAt"], meta1)

# 17 with _plan.statusOrder, phases sort by status: done, in progress, not started, skipped. A planned feature left in
# progress drops below the done ones and renumbers; a later record uses its new number; finished again, it stays
# at the end of the done ones (records with stay), or goes back to its old place (older records without it)
r1 = rec_of("F2.1=progress")
r2 = rec_of("F6.1=done")
m = with_records(r1)
check("no statusOrder: stored order", m.pnum["p-pantry-gauge"] == "F2")
m = with_records(r1, plan=sorted_plan)
check("in progress below done", m.pnum["p-pantry-gauge"] == "F6" and m.pnum["p-pinned-recipes"] == "F5"
      and m.pnum["p-unit-picker"] == "F1", {k: m.pnum[k] for k, _ in m.feats})
m = with_records(r1, r2, plan=sorted_plan)
check("finished stays put", m.pnum["p-pantry-gauge"] == "F6" and m.status["s-stock-data-from-receipts"] == "done",
      {k: m.pnum[k] for k, _ in m.feats})
m = with_records(*[{k: v for k, v in r.items() if k != "stay"} for r in (r1, r2)], plan=sorted_plan)
check("without stay: finished goes back", m.pnum["p-pantry-gauge"] == "F2", {k: m.pnum[k] for k, _ in m.feats})

# 18 a skipped feature sinks below the not-started ones; a core phase in progress drops below the done phases
m = with_records(rec_of("F7.1=skipped", "F7.2=skipped", "3.2=progress"), plan=sorted_plan)
check("skipped last, core phases too", m.pnum["p-leftovers"] == f"F{len(m.feats)}" and m.pnum["p-meal-planner"] == "4"
      and m.pnum["p-polish"] == "3" and m.id_of["4.2"] == "s-live-counts", ({k: m.pnum[k] for k, _ in m.phases + m.feats}))

# 19 a move inside a status group still lands where it's told, by the stored order
m = with_records(rec_of("F2.1=progress"), rec_of("--move", "F1", "after", "F5"), plan=sorted_plan)
check("move within group", m.pnum["p-unit-picker"] == "F5" and m.pnum["p-pantry-gauge"] == "F6",
      {k: m.pnum[k] for k, _ in m.feats})

# 20 a snapshot of a plan without statusOrder keeps what its by-number records meant, then turns the sort on
m = with_records(rec_of("F2.1=progress"), rec_of("F7.1=skipped", "F7.2=skipped"))
F, meta = db.folded(m)
m2 = db.Model({**{k: v for k, v in plan0.items() if k == "_plan" or k.startswith("_seed")}, **F, "_plan": meta}, {}, fe0)
check("fold turns statusOrder on", meta.get("statusOrder") is True and F["s-keep-list-at-meal-end"]["status"] == "skipped"
      and F["s-stock-data-from-receipts"]["status"] == "progress" and m2.pnum["p-pantry-gauge"] == "F6"
      and m2.pnum["p-leftovers"] == f"F{len(m2.feats)}", {k: m2.pnum[k] for k, _ in m2.feats})

# 21 a skipped feature brought back goes to the end of the not-started ones (not back to its old place), a reopened
# one to the top of them, and a snapshot keeps where they went
r1 = rec_of("F7.1=skipped", "F7.2=skipped")
r2 = rec_of("F8.1=todo", "F8.2=todo")
m = with_records(r1, r2, plan=sorted_plan)
check("unskipped to the end of not started", m.pnum["p-leftovers"] == "F8" and m.pnum["p-settings-menu"] == "F7",
      {k: m.pnum[k] for k, _ in m.feats})
F, meta = db.folded(m)
m2 = db.Model({**{k: v for k, v in sorted_plan.items() if k == "_plan" or k.startswith("_seed")}, **F, "_plan": meta}, {}, fe0)
check("snapshot keeps the settled order", "p-leftovers" in F and m2.pnum["p-leftovers"] == "F8", {k: m2.pnum[k] for k, _ in m2.feats})
m = with_records(rec_of("F2.1=todo"), plan=sorted_plan)
check("reopened to the top of not started", m.pnum["p-pantry-gauge"] == "F6" and m.pnum["p-leftovers"] == "F7",
      {k: m.pnum[k] for k, _ in m.feats})
m = with_records(rec_of("F8.1=done", "F8.2=done", "F7.1=done", "F7.2=done"), plan=sorted_plan)
check("two finished in one record keep their order", m.pnum["p-leftovers"] == "F7" and m.pnum["p-settings-menu"] == "F8",
      {k: m.pnum[k] for k, _ in m.feats})

# 18 build selections (features/_build): which phases can be ticked, the report, the claim and the release
def with_build(phases, plan=None):
    return db.Model(plan or plan0, st0, {**fe0, "_build": {"phases": phases}})
m = with_build({"p-settings-menu": {"state": "selected"}, "p-leftovers": {"state": "selected"},
                "p-unit-picker": {"state": "selected"}, "p-gone": {"state": "claimed", "by": "Old"}, "p-polish": None})
check("buildable: open features yes, done no", db.buildable(m, "p-leftovers") and not db.buildable(m, "p-unit-picker")
      and not db.buildable(m, "p-recipe-store"))
order, upd = db.build_claim(m, "Larder build")
check("claim: ticked ones, stale cleared", order == ["p-leftovers", "p-settings-menu"]
      and upd["phases"]["p-leftovers"]["state"] == "claimed" and upd["phases"]["p-leftovers"]["by"] == "Larder build"
      and upd["phases"]["p-unit-picker"] == {"__delete__": True} and upd["phases"]["p-gone"] == {"__delete__": True}
      and "p-polish" not in upd["phases"], upd)
# A mention of a ticked phase's step puts that phase first, whatever the plan order
mp = copy.deepcopy(plan0)
mp["s-keep-list-at-meal-end"]["body"] += "<p>Needs {{S:s-settings-button-and-menu}} first.</p>"
m = with_build({"p-settings-menu": {"state": "selected"}, "p-leftovers": {"state": "selected"}}, plan=mp)
check("build order follows mentions", db.build_order(m, ["p-leftovers", "p-settings-menu"]) == ["p-settings-menu", "p-leftovers"])
rep = db.build_report(m)
check("report", "Ticked to build (2)" in rep and rep.index("F8 Settings Menu") < rep.index("F7 Leftovers")
      and "F7.2 depends on:" in rep, rep)
m = with_build({"p-leftovers": {"state": "selected"}}, plan=mp)
check("report flags an unticked dependency", "F8 Settings Menu [todo, NOT ticked]" in db.build_report(m), db.build_report(m))
# Core phases only when the plan has no batches; a reset planned feature never
cp = copy.deepcopy(plan0)
cp["s-polish-pass"]["status"] = "todo"
m = with_build({}, plan=cp)
check("core phase tickable without batches", db.buildable(m, "p-polish"))
cp["s-recipe-files"]["name"] += " <kbd>Batch 1</kbd>"
m = with_build({}, plan=cp)
check("core phase not tickable with batches", not db.buildable(m, "p-polish") and db.buildable(m, "p-leftovers"))
m = db.Model(plan0, st0, {**fe0, "leftovers": {"decision": "undecided"}})
check("reset feature not tickable", not db.buildable(m, "p-leftovers"))
# Release: named phases, or with none every finished or gone one
m = with_build({"p-leftovers": {"state": "claimed", "by": "X"}, "p-unit-picker": {"state": "claimed", "by": "X"}})
pids, upd = db.build_release(m, [])
check("release finished", pids == ["p-unit-picker"] and upd == {"phases": {"p-unit-picker": {"__delete__": True}}}, upd)
check("report: claimed", "Claimed: F7 Leftovers [todo] [p-leftovers] by X" in db.build_report(m), db.build_report(m))
bdir = Path(tempfile.mkdtemp())
for c, docs in (("plan", plan0), ("statuses", st0), ("features", {"_build": {"phases": {"p-leftovers": {"state": "selected"}}}})):
    (bdir / c).mkdir()
    for k, v in docs.items():
        (bdir / c / f"{k}.json").write_text(json.dumps(v), encoding="utf-8")
out = run("build", bdir, "--claim", "Test", "--out", tmp / "claim.json")
got = json.loads((tmp / "claim.json").read_text(encoding="utf-8"))
check("plan.py build --claim", "claims F7" in out and got["phases"]["p-leftovers"]["by"] == "Test", out)
out = run("build", bdir, "--release", "F7", "--out", tmp / "rel.json")
check("plan.py build --release", json.loads((tmp / "rel.json").read_text(encoding="utf-8")) == {"phases": {"p-leftovers": {"__delete__": True}}}, out)
check("outline ignores _build", "_build" not in run("outline", bdir, "--jobs"))

sys.stdout.reconfigure(encoding="utf-8")
import os
if os.environ.get("DUMP"):
    dump = []
    for pl, sts in CASES:
        mm = db.Model(pl, sts, fe0)
        F, meta = db.folded(mm)
        fr = db.fold_record(mm, F, meta)
        dump.append({"plan": [{"id": k, "body": v} for k, v in pl.items()], "statuses": [{"id": k, "body": v} for k, v in sts.items()],
                     "content": db.build_content(mm), "version": mm.version, "fold": fr["checkpoint"]["entries"],
                     "tokens": mm.tokenize("<p>See 3.6 and F7.2, F8, steps 3.2 and 3.6 (3.6). Not 1.5 days, v3.6, version 3.6, 3.6 s, 1.0 → 1.1, 3.6.1, <code>3.6</code>.</p>")})
    Path(os.environ["DUMP"]).write_text(json.dumps(dump, ensure_ascii=False), encoding="utf-8")
for name, ok, detail in results:
    print(("PASS " if ok else "FAIL ") + name + ("" if ok else f"   {detail}"))
print(f"{sum(ok for _, ok, _ in results)} of {len(results)} passed")
sys.exit(0 if all(ok for _, ok, _ in results) else 1)
