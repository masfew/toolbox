"""folds.py [DBDIR] (default sample-db): what starts folded when a plan page loads, checked in a real headless browser.
Builds a snapshot page from DBDIR with plan.py, puts this repo's plan.js and plan.css beside it and loads variants of it in
Chrome or Edge with --dump-dom: one step set In progress (and one Blocked), a core step In progress, every step done, the
fixture as it is, and links into folded parts. Checks on each: only phases in progress or blocked are open in the overview;
the extra sections sit in one folded .bg-group; the Build Outline is folded exactly when every phase card in it is
finished, with the matching note; the Completed and Rejected idea groups hold their cards, folded; folded content is
hidden="until-found". Then: loading with a link to an extra section or a step opens its group (in Chrome the browser's own
beforematch may do that, so this doesn't prove revealHash()), and the corner button unfolds the folded phase of the next
step. Overview clicks, hashchange and the plain-hidden fallback aren't covered. Skips (exit 0) when no Chrome or Edge is found; set
BROWSER to the browser's path to choose one.
Run: python -I folds.py"""
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
SKILL = HERE.parent / "skill"
DB = Path(sys.argv[1]) if len(sys.argv) > 1 else HERE / "sample-db"
FINISHED = ("done", "skipped")
ACTIVE = ("progress", "blocked")   # the phases that start open
BLOCKED = '<td class="st"><span class="status" data-status="blocked">Blocked</span></td>'
REJECTED = ('<article class="idea-card" data-feature="folds-rejected" data-decision="reject"><div class="idea-text">'
            '<h3>Rejected Idea</h3><p>An idea the user rejected.</p></div></article>')
TODO ='<td class="st"><span class="status" data-status="todo">Not started</span></td>'
PROGRESS = '<td class="st"><span class="status" data-status="progress">In progress</span></td>'
DONE = '<td class="st"><span class="status" data-status="done">Done</span></td>'


def find_browser():
    if os.environ.get("BROWSER"):
        return os.environ["BROWSER"]
    for name in ("chrome", "google-chrome", "chromium", "chromium-browser", "msedge"):
        found = shutil.which(name)
        if found:
            return found
    for p in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
              r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
              "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"):
        if Path(p).exists():
            return p
    return None


def phase_status(sts):
    # plan.js phaseStatus(): a phase is done when every step that isn't skipped is done.
    counted = [s for s in sts if s != "skipped"]
    if not counted:
        return "skipped"
    if all(s == "done" for s in counted):
        return "done"
    if "blocked" in counted:
        return "blocked"
    if "progress" in counted or "done" in counted:
        return "progress"
    return "todo"


def classes(attrs):
    m = re.search(r'class="([^"]*)"', attrs)
    return m.group(1).split() if m else []


def overview(dom):
    """[(phase number, status, folded)] for every overview phase with steps."""
    out = []
    for attrs, body in re.findall(r'<tbody([^>]*data-phase="[^"]*"[^>]*)>(.*?)</tbody>', dom, re.S):
        sts = [m for row in re.findall(r'<tr data-target="[^"]*"[^>]*>(.*?)</tr>', body, re.S)
               for m in re.findall(r'class="status" data-status="(\w+)"', row)[-1:]]
        if sts:
            out.append((re.search(r'data-phase="([^"]*)"', attrs).group(1), phase_status(sts), "is-folded" in classes(attrs)))
    return out


class Run:
    def __init__(self, browser, work):
        self.browser, self.work, self.fails, self.checks, self.n = browser, work, [], 0, 0

    def check(self, ok, what):
        self.checks += 1
        if not ok:
            self.fails.append(what)

    def dump(self, html, hash_="", script=""):
        self.n += 1
        page = self.work / ("page%d.html" % self.n)
        if script:
            html = html.replace('<script src="plan.js"></script>', '<script src="plan.js"></script><script>' + script + '</script>')
        page.write_text(html, encoding="utf-8")
        p = subprocess.run([self.browser, "--headless=new", "--disable-gpu", "--no-first-run",
                            "--user-data-dir=" + str(self.work / "profile"), "--virtual-time-budget=4000", "--dump-dom",
                            page.as_uri() + hash_], capture_output=True, text=True, encoding="utf-8", timeout=120)
        return p.stdout

    def defaults(self, name, html):
        """The rules every freshly loaded page follows."""
        dom = self.dump(html)
        self.check('class="bg-group' in dom or "block-extra" not in html, name + ": the page script didn't run")
        phases = overview(dom)
        self.check(bool(phases), name + ": no overview phases found")
        for num, st, folded in phases:
            self.check(folded == (st not in ACTIVE),"%s: overview phase %s (%s) is %s" % (name, num, st, "folded" if folded else "open"))
        if re.search(r'<section class="block block-extra', dom):
            g = re.search(r'<div class="(bg-group[^"]*)"', dom)
            self.check(bool(g) and "is-collapsed" in g.group(1).split(), name + ": the extra sections' group isn't folded")
            self.check(bool(re.search(r'<div class="bg-body" hidden="until-found"', dom)), name + ": the folded sections aren't hidden until found")
            body_at, end_at = dom.find('class="bg-body"'), dom.find('class="bg-end"')
            inside = [m.start() for m in re.finditer(r'<section class="block block-extra', dom)]
            self.check(body_at > -1 and all(body_at < i < end_at for i in inside), name + ": an extra section sits outside the group")
        d = re.search(r'<section([^>]*id="details"[^>]*)>(.*?)</section>', dom, re.S)
        self.check(bool(d), name + ": no Build Outline")
        if d:
            cards = re.findall(r'class="phase-card"[^>]*>.*?class="status" data-status="(\w+)"', d.group(2), re.S)
            want = bool(cards) and all(s in FINISHED for s in cards)
            folded = "is-collapsed" in classes(d.group(1))
            self.check(folded == want, "%s: Build Outline is %s" % (name, "folded" if folded else "open"))
            self.check(('<div class="fold-body" hidden="until-found"' in d.group(2)) == want, name + ": Build Outline cards hidden wrongly")
            note = re.search(r'class="block-intro fold-note"[^>]*>([^<]*)<', d.group(2))
            done = sum(s == "done" for s in cards)
            self.check(bool(note) and (note.group(1).startswith("All %d phases " % len(cards)) if want
                                       else note.group(1) == "%d of %d phases done" % (done, len(cards))),
                       "%s: Build Outline note reads %r" % (name, note and note.group(1)))
        for key in ("completed", "rejected"):
            g = re.search(r'<div class="(feature-group[^"]*)" data-group="%s"[^>]*>(.*?)<div class="group-list"([^>]*)>' % key, dom, re.S)
            self.check(bool(g) and "is-collapsed" in g.group(1).split() and 'hidden="until-found"' in g.group(3),
                       "%s: the %s group isn't folded" % (name, key))
        return dom, phases


def main():
    browser = find_browser()
    if not browser:
        print("skipped: no Chrome or Edge found (set BROWSER to its path)")
        return 0
    work = Path(tempfile.mkdtemp())
    page = work / "index.html"
    r = subprocess.run([sys.executable, "-I", str(SKILL / "plan.py"), "snapshot", str(DB), "--out", str(page)],
                       capture_output=True, text=True, encoding="utf-8")
    if r.returncode:
        print("FAIL plan.py snapshot: " + (r.stderr or r.stdout).strip()[-300:])
        return 1
    for f in ("plan.js", "plan.css"):
        shutil.copy(SKILL / f, work / f)
    base = page.read_text(encoding="utf-8")
    run = Run(browser, work)

    run.check(TODO in base and DONE in base, "the fixture has no not-started or done step to work with")
    board = '<div class="feature-board" id="feature-board">'
    run.check(board in base, "the page has no Future Ideas board")
    base = base.replace(board, board + REJECTED, 1)
    # One step In progress: its phase is the only one open. The Completed and Rejected groups hold cards, folded away.
    dom, phases = run.defaults("one in progress", base.replace(TODO, PROGRESS, 1))
    run.check(any(st == "progress" for _, st, _ in phases), "one in progress: no phase in progress to check")
    for key, card in (("completed", 'class="phase-card"'), ("rejected", 'data-feature="folds-rejected"')):
        m = re.search(r'<div class="feature-group[^"]*" data-group="%s".*?<div class="group-list"[^>]*>(.*?)</div>\s*</div>' % key, dom, re.S)
        run.check(bool(m) and card in m.group(1), "one in progress: the %s group doesn't hold its card" % key)
    # A blocked phase starts open too.
    dom, phases = run.defaults("one blocked", base.replace(TODO, BLOCKED, 1))
    run.check(any(st == "blocked" for _, st, _ in phases), "one blocked: no blocked phase to check")
    # A core step In progress: the Build Outline stays open, with "N of M phases done".
    dom, phases = run.defaults("core in progress", base.replace(DONE, PROGRESS, 1))
    d = re.search(r'<section([^>]*id="details"[^>]*)>', dom)
    run.check(bool(d) and "is-collapsed" not in classes(d.group(1)), "core in progress: the Build Outline is folded")
    # Every step done: the Build Outline folds, with its "All N phases" note.
    run.defaults("all done", base.replace(TODO, DONE))
    # The fixture as it is: nothing in progress, so every phase starts folded.
    dom, phases = run.defaults("as is", base)
    waiting = [x for x in phases if x[1] not in FINISHED]
    run.check(bool(waiting) and waiting[0][2], "as is: the next step's phase doesn't start folded, so the corner button check proves nothing")

    # Links into folded parts open them: an extra section, and a step in the Build Outline.
    extras = re.findall(r'<section class="block block-extra[^"]*" id="([^"]+)"', base)
    if extras:
        dom = run.dump(base, "#" + extras[-1])
        g = re.search(r'<div class="(bg-group[^"]*)"', dom)
        run.check(bool(g) and "is-collapsed" not in g.group(1).split(), "#%s didn't open the extra sections' group" % extras[-1])
    all_done = base.replace(TODO, DONE)
    step = re.search(r'<details class="step-card" id="(step-1-1)"', all_done)
    if step:
        dom = run.dump(all_done, "#" + step.group(1))
        d = re.search(r'<section([^>]*id="details"[^>]*)>', dom)
        run.check(bool(d) and "is-collapsed" not in classes(d.group(1)), "#step-1-1 didn't open the Build Outline")

    # The corner button unfolds the folded phase holding the next step.
    dom = run.dump(base, script="setTimeout(function(){var b=document.querySelector('.to-top');if(b)b.click();},500);")
    first = next(((num, folded) for num, st, folded in overview(dom) if st not in FINISHED), None)
    run.check(bool(first) and not first[1], "the corner button left phase %s folded" % (first and first[0]))

    shutil.rmtree(work, ignore_errors=True)
    for f in run.fails:
        print("FAIL " + f)
    print("%d of %d passed" % (run.checks - len(run.fails), run.checks))
    return 1 if run.fails else 0


if __name__ == "__main__":
    sys.exit(main())
