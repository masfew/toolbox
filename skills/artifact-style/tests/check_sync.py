#!/usr/bin/env python3
"""
Checks that artifact-style's house.css and the better-plans skill's plan.css use
the same colour and font tokens, so plan pages and other Artifact pages look
like one set. Only useful when better-plans is installed too.

    python -I check_sync.py                 find plan.css by itself
    python -I check_sync.py <plan.css>      check against that file

Without a path it looks for plan.css next to this tool in the same clone, then
in an installed better-plans (~/.claude/tools/better-plans/skill, then
~/.claude/skills/better-plans), and says so when it finds none.

Compares every custom property (--name: value) that both files define, in the
light block and in each dark block. Plan-only tokens (card trays and heads) are
ignored. Exits 0 and prints "in sync", or exits 1 and lists each difference.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
HOUSE = HERE.parent / "skill" / "house.css"
PLAN_PLACES = [
    HERE.parent.parent / "better-plans" / "skill" / "plan.css",
    Path.home() / ".claude" / "tools" / "better-plans" / "skill" / "plan.css",
    Path.home() / ".claude" / "skills" / "better-plans" / "plan.css",
]

# The three token blocks, in order: light :root, dark media query, [data-theme="dark"].
BLOCKS = [
    ("light", r":root\s*\{"),
    ("dark (media)", r':root:not\(\[data-theme="light"\]\)\s*\{'),
    ("dark (data-theme)", r':root\[data-theme="dark"\]\s*\{'),
]


def tokens(css, start_pattern):
    m = re.search(start_pattern, css)
    if not m:
        return None
    body = css[m.end():css.index("}", m.end())]
    return dict(re.findall(r"(--[\w-]+)\s*:\s*([^;]+);", body))


def find_plan_css(args):
    if args:
        return Path(args[0]).expanduser()
    return next((p for p in PLAN_PLACES if p.is_file()), None)


def main():
    plan = find_plan_css(sys.argv[1:])
    if plan is None:
        print("FAILED: couldn't find better-plans' plan.css. Looked in:")
        for p in PLAN_PLACES:
            print(f"  {p}")
        print("Install better-plans, or pass the path to its plan.css.")
        return 1
    for path in (HOUSE, plan):
        if not path.exists():
            print(f"FAILED: {path} is missing.")
            return 1
    print(f"comparing {HOUSE} with {plan}")
    house_css = HOUSE.read_text(encoding="utf-8")
    plan_css = plan.read_text(encoding="utf-8")
    problems = []
    for name, pattern in BLOCKS:
        a, b = tokens(house_css, pattern), tokens(plan_css, pattern)
        if a is None or b is None:
            problems.append(f"{name}: block not found in {'house.css' if a is None else 'plan.css'}")
            continue
        for key in sorted(set(a) & set(b)):
            if " ".join(a[key].split()) != " ".join(b[key].split()):
                problems.append(f"{name}: {key} is {a[key].strip()} in house.css but {b[key].strip()} in plan.css")
        missing = sorted(k for k in set(b) - set(a) if not k.startswith("--card-"))
        for key in missing:
            problems.append(f"{name}: {key} is in plan.css but not house.css")
    if problems:
        print("OUT OF SYNC:")
        for p in problems:
            print("  " + p)
        return 1
    print("in sync")
    return 0


if __name__ == "__main__":
    sys.exit(main())
