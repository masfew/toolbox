"""realcmp.py OLD NEW DIR...: build each listed plan with the old and new dbplan and print the differing lines."""
import difflib, importlib.util, json, sys
from pathlib import Path

def load(skill, name):
    spec = importlib.util.spec_from_file_location(name, Path(skill) / "dbplan.py")
    mod = importlib.util.module_from_spec(spec); sys.path.insert(0, skill); spec.loader.exec_module(mod); sys.path.pop(0)
    return mod
old, new = load(sys.argv[1], "dbold"), load(sys.argv[2], "dbnew")
sys.stdout.reconfigure(encoding="utf-8")
cases = []
for d in sys.argv[3:]:
    pl, st, fe = new.load_dir(Path(d))
    a, b = old.Model(pl, st, fe), new.Model(pl, st, fe)
    ca, cb = old.build_content(a), new.build_content(b)
    adds = [k for k, r in st.items() if isinstance(r, dict) and r.get("add")]
    print(f"== {d}: {len(st)} records, add records {adds}, version {a.version}/{b.version}, misses old {len(a.misses)} new {len(b.misses)}")
    for x in b.misses:
        if x not in a.misses: print("   new miss:", x)
    for line in difflib.unified_diff(ca.split("\n"), cb.split("\n"), lineterm="", n=0):
        if not line.startswith(("---", "+++", "@@")): print("  ", line[:300])
    cases.append({"plan": [{"id": k, "body": v} for k, v in pl.items()], "statuses": [{"id": k, "body": v} for k, v in st.items()],
                  "content": cb, "version": b.version, "fold": new.fold_record(b, *new.folded(b))["checkpoint"]["entries"],
                  "tokens": b.tokenize("<p>See 3.6 and F7.2, F8, steps 3.2 and 3.6 (3.6). Not 1.5 days, v3.6, version 3.6, 3.6 s, 1.0 → 1.1, 3.6.1, <code>3.6</code>.</p>")})
Path("real-cases.json").write_text(json.dumps(cases, ensure_ascii=False), encoding="utf-8")
