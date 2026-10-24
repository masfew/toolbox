"""idea:<id> targets: both `idea:x` and the doc id the outline prints (`idea:i-x`) must resolve, in dbplan.py (the
scripts) and in plan.js (the page), and `outline --show idea:i-x` must show the idea. Run: python -I idea_target.py
Needs node for the plan.js half (skipped with a note if it isn't installed)."""
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / "skill"
sys.path.insert(0, str(SKILL))
import dbplan as db  # noqa: E402

PLAN = {
    "_plan": {"title": "T", "summary": "<p>S</p>", "version": "1.0", "created": "2026-10-01", "updated": "2026-10-01",
              "bakedAt": "2026-10-01T00:00:00.000Z"},
    "p-one": {"kind": "phase", "name": "One", "intro": "<p>I</p>", "sort": 1000},
    "s-one": {"kind": "step", "phase": "p-one", "name": "Step", "body": "<p>B</p>", "sort": 1000},
    "i-move-it": {"kind": "idea", "feature": "move-it", "name": "Move it", "sentence": "Moves the thing.",
                  "details": "<p>Needs a helper.</p>", "sort": 1000},
    "i-i-odd": {"kind": "idea", "feature": "i-odd", "name": "Odd", "sentence": "Doc id i-i-odd.",
                "details": "<p>Odd helper.</p>", "sort": 2000},
}
# One record per target form; each swaps the idea's details.
RECORDS = {
    "r-a": {"at": "2026-10-02T00:00:00.000Z", "swaps": [{"in": "idea:move-it", "old": "helper", "new": "tool"}]},
    "r-b": {"at": "2026-10-02T00:00:01.000Z", "swaps": [{"in": "idea:i-move-it", "old": "tool", "new": "script"}]},
    "r-c": {"at": "2026-10-02T00:00:02.000Z", "swaps": [{"in": "idea:i-i-odd", "old": "helper", "new": "tool"}]},  # the doc id of an idea whose feature id starts with i-
    "r-d": {"at": "2026-10-02T00:00:03.000Z", "swaps": [{"in": "idea:i-i-odd", "old": "tool", "new": "script"}]},
    "r-e": {"at": "2026-10-02T00:00:04.000Z", "swaps": [{"in": "idea:i-nope", "old": "x", "new": "y"}]},   # must still miss
}
EXPECT = {"i-move-it": "<p>Needs a script.</p>", "i-i-odd": "<p>Odd script.</p>"}
fails = []


def check(label, ok, extra=""):
    print(("ok   " if ok else "FAIL ") + label + (f"  {extra}" if extra and not ok else ""))
    if not ok:
        fails.append(label)


m = db.Model(json.loads(json.dumps(PLAN)), RECORDS)
for k, want in EXPECT.items():
    check(f"dbplan: records on {k}", m.E[k]["details"] == want, m.E[k]["details"])
check("dbplan: idea:i-nope still a miss", len(m.misses) == 1 and "idea:i-nope" in m.misses[0], str(m.misses))
for ref, want in [("idea:move-it", "i-move-it"), ("idea:i-move-it", "i-move-it"), ("idea:i-i-odd", "i-i-odd"),
                  ("idea:i-odd", "i-i-odd"), ("idea:i-nope", None), ("i-move-it", "i-move-it")]:
    check(f"dbplan: resolve {ref}", m.resolve(ref) == want, str(m.resolve(ref)))
for show in ("idea:move-it", "idea:i-move-it", "i-move-it"):
    text = db.outline(m, show=[show])
    check(f"dbplan: outline --show {show}", "sentence: Moves the thing." in text)
check("dbplan: outline without --show hides the sentence", "sentence: Moves the thing." not in db.outline(m))

if shutil.which("node"):
    # Run plan.js's model code under node: expose buildModel and resolve, don't start the page (boot, database),
    # and swap textOf, the one model function that needs a DOM, for a tag-stripping stand-in.
    js = (SKILL / "plan.js").read_text(encoding="utf-8")
    for old, new in [("if (!main) return;", "globalThis.__pl = { buildModel: buildModel, resolve: resolve };"),
                     ("var teardown = boot();\n  startDatabase();", ""),
                     ("function textOf(html) { return parse(html).textContent.trim(); }",
                      "function textOf(html) { return String(html).replace(/<[^>]*>/g, '').trim(); }")]:
        assert old in js, "plan.js changed: update this test's stand-ins: " + old
        js = js.replace(old, new, 1)
    harness = (
        "globalThis.window = {}; globalThis.document = { querySelector: function () { return { childNodes: [] }; }, createElement: function () { return {}; } };\n"
        + js + "\n"
        "var d = JSON.parse(require('fs').readFileSync(process.argv[2], 'utf8'));\n"
        "var plan = Object.keys(d.plan).map(function (k) { return { id: k, body: d.plan[k] }; });\n"
        "var recs = Object.keys(d.records).map(function (k) { return { id: k, body: d.records[k] }; });\n"
        "var m = __pl.buildModel(plan, recs);\n"
        "var out = { details: {}, resolve: {} };\n"
        "['i-move-it', 'i-i-odd'].forEach(function (k) { out.details[k] = m.E[k].details; });\n"
        "d.refs.forEach(function (r) { out.resolve[r] = __pl.resolve(m, r); });\n"
        "console.log(JSON.stringify(out));\n")
    refs = ["idea:move-it", "idea:i-move-it", "idea:i-i-odd", "idea:i-odd", "idea:i-nope", "i-move-it"]
    with tempfile.TemporaryDirectory() as tmp:
        (Path(tmp) / "h.js").write_text(harness, encoding="utf-8")
        (Path(tmp) / "d.json").write_text(json.dumps({"plan": PLAN, "records": RECORDS, "refs": refs}), encoding="utf-8")
        run = subprocess.run(["node", str(Path(tmp) / "h.js"), str(Path(tmp) / "d.json")], capture_output=True, text=True)
    if run.returncode:
        check("plan.js runs under node", False, run.stderr[:700])
    else:
        got = json.loads(run.stdout)
        for k, want in EXPECT.items():
            check(f"plan.js: records on {k}", got["details"][k] == want, got["details"][k])
        for ref in refs:
            check(f"plan.js: resolve {ref}", got["resolve"][ref] == m.resolve(ref), f"{got['resolve'][ref]} vs {m.resolve(ref)}")
else:
    print("note: node not found, plan.js half skipped")

print("FAILED: " + ", ".join(fails) if fails else "all passed")
sys.exit(1 if fails else 0)
