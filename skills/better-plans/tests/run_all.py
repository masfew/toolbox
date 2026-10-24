"""run_all.py: every better-plans test against this repo's skill/ — scen.py (Python model), parity.js (plan.js against
scen.py's cases), autosnap.js (the page's automatic snapshot) and idea_target.py. Needs node on PATH.
Run: python -I run_all.py. Exits 1 if any suite fails."""
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
cases = Path(tempfile.mkdtemp()) / "cases.json"
SUITES = [
    ("scen.py", [sys.executable, "-I", str(HERE / "scen.py")], {"DUMP": str(cases)}),
    ("parity.js", ["node", str(HERE / "parity.js"), str(cases)], {}),
    ("autosnap.js", ["node", str(HERE / "autosnap.js")], {}),
    ("idea_target.py", [sys.executable, "-I", str(HERE / "idea_target.py")], {}),
]
failed = []
for name, cmd, env in SUITES:
    p = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", env={**os.environ, **env})
    lines = (p.stdout or "").strip().splitlines()
    for line in lines:
        if line.startswith("FAIL") or line.startswith("case "):
            print(f"  {name}: {line}")
    print(f"{'ok  ' if p.returncode == 0 else 'FAIL'} {name}: {lines[-1] if lines else (p.stderr or '').strip()[-300:]}")
    if p.returncode:
        failed.append(name)
sys.exit(1 if failed else 0)
