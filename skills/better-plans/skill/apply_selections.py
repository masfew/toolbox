"""Bring a better-plans page in line with the user's future idea choices.

Two commands, run on the page's HTML (the file the Artifact tool's `read` saves) and the
page's `features` collection (the folder ArtifactData `list` with `out_dir` writes):

  report  Prints what needs doing: accepted ideas to plan (with their text and details),
          edits to make (with the lines of the card they change), planned features to take
          out, rejected ideas, a new order, and the references to feature numbers elsewhere
          on the page that apply will renumber.
  apply   Does every mechanical part in one go and writes the updated page:
            - rewraps the content in template.html, whose styles and script live in plan.css and
              plan.js beside the page (an older single-file page moves to this split format, and
              then has to be published with files), and renames an older Future Features heading
            - plans each accepted idea from the steps Claude wrote in a plans file
            - takes out reset features, applies the dragged order, renumbers F1, F2 ...
              (also mentions of a moved feature's number elsewhere on the page, each printed)
            - records rejected ideas on their cards
            - recounts progress, bumps the version and sets Last updated
          It prints the ArtifactData writes that clear the edits Claude made. --files FOLDER
          copies plan.css and plan.js into FOLDER for a publish with files.

Both take --db FOLDER, the statuses folder ArtifactData list wrote: step statuses saved in the
database since the last publish are written into the page first (see plan.py status).

The plans file is JSON keyed by data-feature id:
  {"decisions-log": {"short": "Decisions",            (optional: the overview's phase name)
                     "desc": "...",                    (optional: replaces the idea's sentence)
                     "steps": [{"name": "Step Name", "body": "<h5>What</h5><p>...</p>",
                                "status": "todo"}]},   (status optional, default todo)
   "some-reset-feature": {"details": "<h5>Options</h5>..."}}   (optional idea details)
"""

import argparse
import datetime
import html
import json
import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
START = "<!-- PLAN CONTENT START"
END = "<!-- PLAN CONTENT END -->"
OLD_DECISIONS = {"keep": "accept", "remove": "reject"}
CSS_LINK = '<link rel="stylesheet" href="plan.css">'
FILES_NOTE = ("publish it with plan.css and plan.js beside it, since it now loads its styles and script from them. "
              "Copy them into your scratchpad first (the Artifact tool only publishes files from there or the working "
              "directory): --files <scratchpad> on plan.py finish or apply_selections.py apply, or plan.py files <scratchpad>. Then publish with "
              'files: {"plan.css": "<scratchpad>/plan.css", "plan.js": "<scratchpad>/plan.js"}')
LABELS = {"todo": "Not started", "progress": "In progress", "done": "Done", "blocked": "Blocked", "skipped": "Skipped"}
PILL = re.compile(r'<span class="status" data-status="(\w+)">[^<]*</span>')
# The database rules every plan declares: the future ideas' choices and the step status records, which only the owner
# and editors can change and every viewer can read.
CAPABILITIES = ('{"db": {"rules": [{"path": "features", "read": "view", "write": "admin"}, '
                '{"path": "statuses", "read": "view", "write": "admin"}]}, "user": {}}')
SETUP_NOTE = ("this plan isn't set up for database statuses yet (its statuses collection has no _meta document). "
              "Set it up with this publish: copy the files with --files <scratchpad>, have the publish pass "
              'files: {"plan.css": "<scratchpad>/plan.css", "plan.js": "<scratchpad>/plan.js"} and capabilities: '
              + CAPABILITIES + " (the Artifact tool only replaces plan.js once this session has listed the plan's files), "
              'then in the same message after the publish, ArtifactData set statuses/_meta to {"statuses": 1}')


def fail(msg):
    sys.exit(f"error: {msg}")


def pill(st):
    return f'<span class="status" data-status="{st}">{LABELS[st]}</span>'


def set_status(s, num, st, changes, source=""):
    """Sets a step's status in its overview row and on its card. A step the page doesn't have stops the script,
    unless the status came from a database record (source), which is then left out with a note."""
    row = re.compile(rf'(<td class="step" data-step="{re.escape(num)}">[\s\S]*?<td class="st">){PILL.pattern}')
    card = re.compile(rf'(<details class="step-card" id="step-{re.escape(num.replace(".", "-"))}"[^>]*>[\s\S]*?){PILL.pattern}')
    rm, cm = row.search(s), card.search(s)
    if not rm or not cm:
        if source:
            changes.append(f"step {num} {source} isn't on the page: left out")
            return s
        known = re.findall(r'<td class="step" data-step="([^"]+)"', s)
        where = "overview row or card" if not rm and not cm else ("overview row" if not rm else "step card")
        fail(f"step {num} not found (no {where}). Steps on this page: {', '.join(known)}")
    old = cm.group(2) if cm.group(2) == rm.group(2) else f"{rm.group(2)} (card {cm.group(2)})"
    s = row.sub(lambda m: m.group(1) + pill(st), s, count=1)
    s = card.sub(lambda m: m.group(1) + pill(st), s, count=1)
    note = f" {source}" if source else ""
    changes.append(f"step {num}: {old} -> {st}{note}" if old != st else f"step {num}: already {st}{note}")
    return s


# ---------------------------------------------------------------------------------------------- database statuses
# A status-only update adds one document to the plan's "statuses" collection instead of republishing:
# {"steps": {"2.3": "done"}, "at": ISO time, "date": "YYYY-MM-DD"} (plan.py status writes it). The page shows the
# latest status of each step over the HTML. The next republish folds the records into the HTML and stamps the newest
# one's time on the header's <dl class="meta" data-baked="...">; the page and these scripts ignore records at or before
# that time, so they're only deleted later, once a published page is known to hold them.

def load_statuses(folder):
    """The records in the folder ArtifactData list wrote for the statuses collection (the folder itself, or the
    out_dir holding a statuses folder), oldest first, and whether the _meta document is there."""
    p = Path(folder)
    if (p / "statuses").is_dir():
        p = p / "statuses"
    records, has_meta = [], False
    for f in sorted(p.glob("*.json")) if p.is_dir() else []:
        if f.stem == "_meta":
            has_meta = True
            continue
        if f.stem.startswith("_"):
            continue
        body = json.loads(f.read_text(encoding="utf-8"))
        steps, at = body.get("steps"), body.get("at")
        if not isinstance(steps, dict) or not isinstance(at, str):
            continue
        date = body.get("date") if isinstance(body.get("date"), str) and re.fullmatch(r"\d{4}-\d\d-\d\d", body.get("date")) else at[:10]
        records.append({"id": f.stem, "at": at, "date": date,
                        "steps": {k: v for k, v in steps.items() if v in LABELS}})
    records.sort(key=lambda r: (r["at"], r["id"]))
    return records, has_meta


def baked_at(s):
    m = re.search(r'<dl class="meta" data-baked="([^"]*)"', s)
    return m.group(1) if m else ""


def fold_statuses(s, records, changes):
    """Applies the records newer than the page's data-baked time, oldest first, and moves data-baked to the newest.
    Returns the page, the records folded in, and the ids of records the page already held (safe to delete)."""
    old = baked_at(s)
    new = [r for r in records if r["at"] > old]
    stale = [r["id"] for r in records if r["at"] <= old]
    for r in new:
        for num, st in r["steps"].items():
            s = set_status(s, num, st, changes, f"(database, {r['date']})")
    if new:
        stamp = f'<dl class="meta" data-baked="{new[-1]["at"]}"'
        s, n = re.subn(r'<dl class="meta"(?: data-baked="[^"]*")?', lambda _: stamp, s, count=1)
        if not n:
            fail("the page has no <dl class=\"meta\"> in its header to stamp the folded statuses on")
    return s, new, stale


def db_notes(new, stale, has_meta):
    """What the session does with the database after a republish that folded statuses in."""
    notes = []
    if new:
        notes.append(f"folded {len(new)} status update{'s' if len(new) != 1 else ''} from the database into the page "
                     f"(each counts as an update in the version)")
    if stale:
        notes.append("status records the published page already holds, deleted in the ArtifactData batch after the "
                     "publish (op delete, collection statuses, if_version from the list): " + ", ".join(stale))
    if not has_meta:
        notes.append(SETUP_NOTE)
    return notes


def copy_files(folder):
    """Copies plan.css and plan.js into folder (the Artifact tool only publishes supporting files
    from the session's working directory or scratchpad) and prints the publish's files value."""
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    for name in ("plan.css", "plan.js"):
        shutil.copyfile(HERE / name, folder / name)
    files = {name: (folder / name).as_posix() for name in ("plan.css", "plan.js")}
    print("Copied plan.css and plan.js. Publish with files: " + json.dumps(files))


def block_end(s, i, tag):
    """Index just past the element that opens at s[i], counting nested tags of the same name."""
    pat = re.compile(rf"<(/?){tag}\b[^>]*>", re.I)
    depth = 0
    for m in pat.finditer(s, i):
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.end()
    fail(f"unclosed <{tag}> at {i}")


def attr(tag_html, name):
    m = re.search(rf'\b{name}="([^"]*)"', tag_html)
    return m.group(1) if m else None


def text_of(fragment):
    return html.unescape(re.sub(r"<[^>]+>", "", fragment)).strip()


def inner(s, tag):
    """Inner HTML of the first <tag> in s."""
    m = re.search(rf"<{tag}\b[^>]*>", s)
    if not m:
        return None
    return s[m.end():block_end(s, m.start(), tag) - len(f"</{tag}>")]


def load_choices(folder):
    choices, order = {}, None
    if not folder:
        return choices, order
    for p in sorted(Path(folder).glob("*.json")):
        body = json.loads(p.read_text(encoding="utf-8"))
        if p.stem == "_order":
            order = [x for x in body.get("order", []) if isinstance(x, str)]
            continue
        if p.stem.startswith("_"):   # _build (build selections) and any other document that isn't a feature's
            continue
        d = OLD_DECISIONS.get(body.get("decision"), body.get("decision"))
        choices[p.stem] = {"decision": d if d in ("accept", "reject") else "undecided",
                           "edit": body.get("edit") if isinstance(body.get("edit"), str) else ""}
    return choices, order


def is_split(text):
    """True when the page loads its styles and script from plan.css and plan.js."""
    return CSS_LINK in text


def plan_styles(text):
    """The page's own <style> blocks (plan-specific rules), leaving out the template's styles
    and the style the Artifact runtime puts in the saved file's <head>."""
    body = text.find("<body>")
    out = []
    for m in re.finditer(r"<style\b[^>]*>[\s\S]*?</style>", text[:text.find(START)]):
        if m.start() < body or "better-plans template" in m.group(0):
            continue
        out.append(m.group(0))
    return out


def wrap(content, title, styles, template):
    """The page as template.html lays it out (head, links and script tag) around the content,
    keeping the page's title and any plan-specific <style> blocks."""
    a = template.index("\n", template.index(START)) + 1
    head, tail = template[:a], template[template.index(END):]
    head = re.sub(r"<title>.*?</title>", lambda _: f"<title>{title}</title>", head, count=1, flags=re.S)
    if styles:
        head = head.replace(CSS_LINK + "\n", CSS_LINK + "\n" + "\n".join(styles) + "\n", 1)
    return head + content + tail


class Page:
    def __init__(self, text):
        a, b = text.find(START), text.find(END)
        if a < 0 or b < 0:
            fail("the page has no PLAN CONTENT markers")
        a = text.index("\n", a) + 1
        self.text, self.offset = text, a
        self.content = text[a:b]
        m = re.search(r"<title>(.*?)</title>", text, re.S)
        self.title = m.group(1) if m else ""
        self.styles = plan_styles(text)
        self.split = is_split(text)

    # The overview's tbodies, as (start, end, html) in content order.
    def tbodies(self):
        t0 = self.content.find('class="table overview"')
        t1 = self.content.find("</table>", t0)
        out = []
        for m in re.finditer(r"<tbody\b[^>]*>", self.content[t0:t1]):
            st = t0 + m.start()
            en = self.content.index("</tbody>", st) + len("</tbody>")
            out.append((st, en, self.content[st:en]))
        return out

    def board(self):
        m = re.search(r'<div class="feature-board" id="feature-board">', self.content)
        if not m:
            fail("the page has no feature board")
        return m.end(), block_end(self.content, m.start(), "div") - len("</div>")

    # The board's cards in order: dicts with kind, id, html.
    def cards(self):
        b0, b1 = self.board()
        out, i = [], b0
        body = self.content
        while True:
            m = re.compile(r"<(article|details)\b[^>]*>").search(body, i, b1)
            if not m:
                break
            end = block_end(body, m.start(), m.group(1))
            h = body[m.start():end]
            out.append({"kind": "planned" if m.group(1) == "details" else "idea",
                        "id": attr(m.group(0), "data-feature"), "html": h, "at": (m.start(), end)})
            i = end
        return out

    def line(self, i):
        """'L12': the saved file's line holding content[i], as the Read tool numbers it."""
        return f"L{self.text.count(chr(10), 0, self.offset + i) + 1}"

    def lines(self, start, end):
        """'L12-30': the saved file's lines for content[start:end]."""
        return f"{self.line(start)}-{self.line(end)[1:]}"

    def where(self, card):
        """Where an edit to the card goes: the card's lines, and a planned feature's overview rows."""
        out = "card " + self.lines(*card["at"])
        if card["kind"] == "planned":
            num = attr(card["html"][:card["html"].index(">")], "id").replace("phase-", "")
            for st, en, h in self.tbodies():
                if attr(h[:h.index(">")], "data-phase") == num:
                    out += ", overview rows " + self.lines(st, en)
        return out


def feature_info(card):
    h = card["html"]
    if card["kind"] == "idea":
        text = inner(h, "div") or ""
        more = re.search(r'<div class="idea-more[^"]*">', h)
        return {"name": text_of(inner(text, "h3") or ""), "sentence": (inner(text, "p") or "").strip(),
                "details": inner(h[more.start():], "div").strip() if more else "",
                "decision": OLD_DECISIONS.get(attr(h[:h.index(">")], "data-decision"), attr(h[:h.index(">")], "data-decision"))}
    head = inner(h, "summary")
    num = attr(h[:h.index(">")], "id").replace("phase-", "")
    statuses = re.findall(r'class="step-card"[\s\S]*?<span class="status" data-status="(\w+)"', h)
    desc = re.search(r'<p class="feature-desc">([\s\S]*?)</p>', h)
    return {"name": text_of(inner(head, "h3")), "num": num, "statuses": statuses,
            "sentence": desc.group(1).strip() if desc else ""}


def fnum(n):
    return int(n[1:])


def choice_of(card, choices):
    """The card's saved choice. With no saved document a planned feature stays accepted, as on the page."""
    default = "accept" if card["kind"] == "planned" else "undecided"
    return choices.get(card["id"], {"decision": default, "edit": ""})


def report(page, choices, order):
    cards = page.cards()
    # Planned features that stay keep F1 ... Fn (take-outs close the gaps), so new ones follow them.
    nxt = 1 + sum(1 for c in cards if c["kind"] == "planned" and choice_of(c, choices)["decision"] == "accept")
    lines = []
    for c in cards:
        info, ch = feature_info(c), choice_of(c, choices)
        if c["kind"] == "idea" and ch["decision"] == "accept":
            lines.append(f"PLAN {c['id']} as F{nxt}: {info['name']}\n  sentence: {text_of(info['sentence'])}")
            if info["details"]:
                lines.append("  details: " + re.sub(r"\s+", " ", text_of(re.sub(r"<(h5|li|p)\b", r" | <\1", info["details"]))))
            nxt += 1
        if c["kind"] == "planned" and ch["decision"] != "accept":
            started = any(s != "todo" for s in info["statuses"])
            lines.append(f"{'ASK USER (started) before taking out' if started else 'TAKE OUT'} {c['id']} ({info['num']} {info['name']}), now {ch['decision']}")
        if c["kind"] == "idea" and ch["decision"] == "reject" and info["decision"] != "reject":
            lines.append(f"REJECT {c['id']}: {info['name']}")
        if ch["edit"].strip():
            where = ("fold it into the steps you write for it" if c["kind"] == "idea" and ch["decision"] == "accept"
                     else page.where(c))
            lines.append(f"EDIT {c['id']} ({info['name']}; {where}): {ch['edit'].strip()}")
    pending = [(feature_info(c), c["id"]) for c in cards if c["kind"] == "planned"
               and choice_of(c, choices)["decision"] == "accept"]
    if order and new_order(pending, order) != [i for _, i in sorted(pending, key=lambda x: fnum(x[0]["num"])) if is_pending(_)]:
        lines.append("REORDER planned features: " + ", ".join(new_order(pending, order)))
    lines += preview_refs(page, choices, order)
    print("\n".join(lines) if lines else "Nothing to do: the page already matches the choices.")
    print(f"BOARD: a new idea card goes just before the board's closing </div>, on {page.line(page.board()[1])}")


def preview_refs(page, choices, order):
    """The references to feature numbers outside their own cards that apply will renumber (or leave, for a feature
    taken out), found by a trial apply with stand-in steps, so they can be checked before the real one."""
    trial = Page(page.text)
    plans = {c["id"]: {"steps": [{"name": "x", "body": ""}]} for c in trial.cards()
             if c["kind"] == "idea" and choice_of(c, choices)["decision"] == "accept"}
    try:
        _, _, _, refs = apply(trial, choices, order, plans, "<!-- PLAN CONTENT START -->\n<!-- PLAN CONTENT END -->",
                              datetime.date.today(), False)
    except SystemExit:   # a started feature to ask about: apply won't run until the user answers
        return []
    return [f"REFERENCE {r}" for r in refs]


def is_pending(info):
    st = [s for s in info["statuses"] if s != "skipped"]
    return bool(st) and not all(s == "done" for s in st)


def new_order(pending, order):
    ids = [i for info, i in sorted(pending, key=lambda x: fnum(x[0]["num"])) if is_pending(info)]
    pos = {i: n for n, i in enumerate(order or [])}
    return sorted(ids, key=lambda i: (pos.get(i, len(pos)), ids.index(i)))


def step_card(num, m, step):
    st = step.get("status", "todo")
    return f'''      <details class="step-card" id="step-{num}-{m}" open>
        <summary class="card-head">
          <span class="card-title"><span class="card-num">Step {num}.{m}</span><h4>{step["name"]}</h4></span>
          <span class="status" data-status="{st}">{LABELS[st]}</span>
        </summary>
        <div class="step-body">
          <div class="prose">
            {step["body"].strip()}
          </div>
          <a class="back" href="#overview">↑ Back to overview</a>
        </div>
      </details>'''


def phase_status(statuses):
    live = [s for s in statuses if s != "skipped"]
    if not statuses:
        return "todo"
    if not live:
        return "skipped"
    if all(s == "done" for s in live):
        return "done"
    if "blocked" in live:
        return "blocked"
    return "progress" if any(s in ("progress", "done") for s in live) else "todo"


def planned_card(fid, num, name, desc, steps):
    st = phase_status([s.get("status", "todo") for s in steps])
    body = "\n".join(step_card(num, m, s) for m, s in enumerate(steps, 1))
    return f'''<details class="phase-card" id="phase-{num}" data-feature="{fid}" open>
    <summary class="card-head">
      <span class="card-title"><span class="card-num">Feature {num}</span><h3>{name}</h3></span>
      <span class="status" data-status="{st}">{LABELS[st]}</span>
    </summary>
    <div class="phase-body">
      <p class="feature-desc">{desc}</p>
{body}
    </div>
  </details>'''


def planned_rows(fid, num, short, steps):
    rows = []
    for m, s in enumerate(steps, 1):
        st = s.get("status", "todo")
        cell = (f'\n          <th class="phase" scope="rowgroup" rowspan="{len(steps)}" data-target="phase-{num}" tabindex="0">'
                f'<span class="ph"><span class="ph-num">{num}</span><span class="ph-name">{short}</span></span></th>') if m == 1 else ""
        rows.append(f'''        <tr data-target="step-{num}-{m}" tabindex="0">{cell}
          <td class="step" data-step="{num}.{m}"><span class="sn">{num}.{m}</span> {s["name"]}</td>
          <td class="st"><span class="status" data-status="{st}">{LABELS[st]}</span></td>
        </tr>''')
    return f'      <tbody data-phase="{num}">\n' + "\n".join(rows) + "\n      </tbody>"


def renumber(fragment, old, new):
    """Change every F-number reference inside one feature's overview rows or card."""
    return re.sub(rf"(?<![A-Za-z0-9]){old}(?=[.\-\"<\s])", new, fragment)


def context(s, m, width=40):
    """The text around a match, without tags, for a printed note."""
    around = s[max(0, m.start() - width * 3):m.start()] + "[[" + m.group(0) + "]]" + s[m.end():m.end() + width * 3]
    around = re.sub(r"\s+", " ", text_of(re.sub(r"^[^<]*>|<[^>]*$", "", around)))
    i = around.find("[[")
    return around[max(0, i - width):i + len(m.group(0)) + 4 + width].replace("F@@", "F").strip()


def renumber_refs(content, moved, taken):
    """Renumber the F-number references left after each feature's own card and rows were renumbered:
    mentions of a moved feature anywhere else ("pinned tabs (F3)", "F4.2", "#phase-F4").
    Returns the content (new numbers as F@@ placeholders) and a note for every reference changed,
    and for every reference to a feature that was taken out, which is left as it is."""
    notes = []

    def sub(m):
        old = "F" + m.group(1)
        if old in moved:
            notes.append(f'{old} -> {moved[old]}: "{context(content, m)}"')
            return "F@@" + moved[old][1:]
        if old in taken:
            notes.append(f'{old} left as is ({taken[old]} was taken out): "{context(content, m)}"')
        return m.group(0)
    return re.sub(r"(?<![A-Za-z0-9@])F(\d+)(?![0-9A-Za-z])", sub, content), notes


def apply(page, choices, order, plans, template, today, force_major, folded=0):
    cards = page.cards()
    tb = page.tbodies()
    rows = {attr(h[:h.index(">")], "data-phase"): h for _, _, h in tb}
    changes, structural = [], False
    taken = {}   # F-number -> name of each planned feature taken out

    # 1. Decide each card's fate.
    out_cards = []   # (kind, id, html-or-None, info)
    for c in cards:
        info, ch = feature_info(c), choice_of(c, choices)
        if c["kind"] == "planned":
            if ch["decision"] == "accept":
                out_cards.append({"kind": "planned", "id": c["id"], "html": c["html"], "num": info["num"], "info": info})
                continue
            if any(s != "todo" for s in info["statuses"]):
                fail(f"{c['id']} was reset but has started steps: ask the user before taking it out")
            plan = plans.get(c["id"], {})
            dec = ' data-decision="reject"' if ch["decision"] == "reject" else ""
            more = f'\n      <div class="idea-more prose">\n        {plan["details"].strip()}\n      </div>' if plan.get("details") else ""
            idea = (f'<article class="idea-card" data-feature="{c["id"]}"{dec}>\n      <div class="idea-text">\n'
                    f'        <h3>{info["name"]}</h3>\n        <p>{info["sentence"]}</p>\n      </div>{more}\n    </article>')
            out_cards.append({"kind": "idea", "id": c["id"], "html": idea})
            changes.append(f"took out {info['num']} {info['name']}")
            taken[info["num"]] = info["name"]
            structural = True
            continue
        if ch["decision"] == "accept":
            plan = plans.get(c["id"])
            if not plan or not plan.get("steps"):
                fail(f"{c['id']} is accepted but the plans file has no steps for it")
            out_cards.append({"kind": "new", "id": c["id"], "plan": plan, "info": info})
            structural = True
            continue
        h = c["html"]
        open_tag = h[:h.index(">") + 1]
        new_tag = re.sub(r'\s+data-decision="[^"]*"', "", open_tag)
        if ch["decision"] == "reject":
            new_tag = new_tag[:-1] + ' data-decision="reject">'
            if info["decision"] != "reject":
                changes.append(f"rejected {info['name']}")
        out_cards.append({"kind": "idea", "id": c["id"], "html": new_tag + h[len(open_tag):]})

    # 2. Number the planned features: keep order, compact, apply the dragged order, then add the new ones.
    planned = [c for c in out_cards if c["kind"] == "planned"]
    planned.sort(key=lambda c: fnum(c["num"]))
    for n, c in enumerate(planned, 1):
        c["new"] = f"F{n}"
    pend = [c for c in planned if is_pending(c["info"])]
    if order and pend:
        slots = sorted(fnum(c["new"]) for c in pend)
        want = new_order([(c["info"] | {"num": c["new"]}, c["id"]) for c in pend], order)
        by_id = {c["id"]: c for c in pend}
        if want != [c["id"] for c in sorted(pend, key=lambda c: fnum(c["new"]))]:
            structural = True
            changes.append("applied the new order")
        for slot, fid in zip(slots, want):
            by_id[fid]["new"] = f"F{slot}"
    nxt = len(planned) + 1
    for c in out_cards:
        if c["kind"] == "new":
            c["new"] = f"F{nxt}"
            nxt += 1

    # 3. Build each planned feature's card and overview rows.
    # New features' cards and rows are written in the new numbers, so they're set aside from the cross-reference pass.
    feature_rows, set_aside = {}, {}

    def aside(h):
        key = f"@@NEW{len(set_aside)}@@"
        set_aside[key] = h
        return key
    for c in out_cards:
        if c["kind"] == "planned":
            tmp = f"F@@{c['new'][1:]}"   # placeholder, so F2->F1 and F1->F2 don't collide
            c["html"] = renumber(c["html"], c["num"], tmp)
            feature_rows[c["new"]] = renumber(rows[c["num"]], c["num"], tmp)
            if c["new"] != c["num"]:
                changes.append(f"{c['info']['name']} moved from {c['num']} to {c['new']}")
        elif c["kind"] == "new":
            p, info = c["plan"], c["info"]
            name = p.get("name", info["name"])
            c["html"] = aside(planned_card(c["id"], c["new"], name, p.get("desc", info["sentence"]), p["steps"]))
            feature_rows[c["new"]] = aside(planned_rows(c["id"], c["new"], p.get("short", name), p["steps"]))
            changes.append(f"planned {c['new']} {name} ({len(p['steps'])} step{'s' if len(p['steps']) != 1 else ''})")

    # 4. Rewrite the overview: core phases, then the split row and the planned features in number order.
    content = page.content
    first, last = tb[0][0], tb[-1][1]
    core = [h for _, _, h in tb if not attr(h[:h.index(">")], "data-phase") or not attr(h[:h.index(">")], "data-phase").startswith("F")]
    core = [h for h in core if 'class="split"' not in h]
    parts = core[:]
    if feature_rows:
        parts.append('<tbody class="split"><tr><th scope="colgroup" colspan="3">Future Ideas</th></tr></tbody>')
        parts += [feature_rows[k] for k in sorted(feature_rows, key=fnum)]
    content = content[:first] + "\n      ".join(p.strip() for p in parts) + content[last:]

    # 5. Rewrite the board: planned cards fill the planned slots in number order.
    page.content = content
    b0, b1 = page.board()
    slots = [i for i, c in enumerate(out_cards) if c["kind"] in ("planned", "new")]
    ordered = sorted([out_cards[i] for i in slots], key=lambda c: fnum(c["new"]))
    for i, c in zip(slots, ordered):
        out_cards[i] = c
    board = "\n    " + "\n    ".join(c["html"].strip() for c in out_cards) + "\n  "
    if not out_cards:
        board = content[b0:b1]
    content = content[:b0] + board + content[b1:]

    # 6. Renumber references to moved features elsewhere on the page, then put the new features back.
    moved = {c["num"]: c["new"] for c in out_cards if c["kind"] == "planned" and c["new"] != c["num"]}
    content, refs = renumber_refs(content, moved, taken)
    for key, h in set_aside.items():
        content = content.replace(key, h)
    content = content.replace("F@@", "F")

    # 7. Phase statuses, progress, version and date.
    def fix_phase(m):
        card = content[m.start():block_end(content, m.start(), "details")]
        sts = re.findall(r'class="step-card"[\s\S]*?<span class="status" data-status="(\w+)"', card)
        st = phase_status(sts)
        return re.sub(r'<span class="status" data-status="\w+">[^<]*</span>', f'<span class="status" data-status="{st}">{LABELS[st]}</span>', m.group(0), count=1)
    content = re.sub(r'<details class="phase-card"[^>]*>\s*<summary class="card-head">[\s\S]*?</summary>', fix_phase, content)
    t0, t1 = content.find('class="table overview"'), content.find("</table>")
    sts = re.findall(r'<td class="st"><span class="status" data-status="(\w+)"', content[t0:t1])
    live = [s for s in sts if s != "skipped"]
    content = re.sub(r"(<span class=\"progress\" data-progress>)[^<]*(</span>)",
                     rf"\g<1>{sum(s == 'done' for s in live)} of {len(live)} done\g<2>", content, count=1)
    m = re.search(r"<dt>Version</dt><dd>(\d+)\.(\d+)</dd>", content)
    major = structural or force_major
    # Each status update folded in from the database counted as an update of its own.
    ver = f"{int(m.group(1)) + 1}.0" if major else f"{m.group(1)}.{int(m.group(2)) + 1 + folded}"
    content = content[:m.start()] + f"<dt>Version</dt><dd>{ver}</dd>" + content[m.end():]
    content = re.sub(r'(<dt>Last updated</dt><dd><time datetime=")[^"]*(">)[^<]*(</time>)',
                     rf"\g<1>{today.isoformat()}\g<2>{today.day} {today.strftime('%b %Y')}\g<3>", content, count=1)

    # 8. Pages made before the rename head the section Future Features. Then wrap it in the latest template.
    if "<h2>Future Features</h2>" in content:
        content = content.replace("<h2>Future Features</h2>", "<h2>Future Ideas</h2>")
        changes.append("renamed the Future Features heading to Future Ideas")
    if not page.split:
        changes.append("moved the page to the split format: " + FILES_NOTE)
    return wrap(content, page.title, page.styles, template), ver, changes, refs


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=["report", "apply"])
    ap.add_argument("page", help="the plan's HTML (the file the Artifact tool's read saved)")
    ap.add_argument("--choices", help="the features folder ArtifactData list wrote with out_dir")
    ap.add_argument("--db", metavar="FOLDER", help="the statuses folder ArtifactData list wrote with out_dir: step statuses saved since the last publish, folded in first")
    ap.add_argument("--plans", help="JSON of steps for accepted features (apply)")
    ap.add_argument("--out", help="where to write the updated page (apply); default: overwrite the page")
    ap.add_argument("--template", default=str(HERE / "template.html"))
    ap.add_argument("--major", action="store_true", help="force a major version bump, e.g. when an edit added or removed steps")
    ap.add_argument("--date", help="Last updated date, YYYY-MM-DD; default today")
    ap.add_argument("--files", metavar="FOLDER", help="apply: also copy plan.css and plan.js into FOLDER (your scratchpad) "
                                                     "for the publish, when the page moves to the split format or is set up")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # page text in the notes isn't always cp1252
    text = Path(args.page).read_text(encoding="utf-8")
    db_changes, new, stale, has_meta = [], [], [], True
    if args.db:
        records, has_meta = load_statuses(args.db)
        text, new, stale = fold_statuses(text, records, db_changes)
    page = Page(text)
    choices, order = load_choices(args.choices)
    if args.command == "report":
        for c in db_changes:
            print(f"STATUS {c}")
        if stale:
            print("DELETE status records the page already holds, in step 6's batch: " + ", ".join(stale))
        if not has_meta:
            print("SET UP database statuses with this publish: " + SETUP_NOTE)
        if not page.split:
            print("FORMAT single file: apply moves the page to the split format, so " + FILES_NOTE)
        report(page, choices, order)
        return
    plans = json.loads(Path(args.plans).read_text(encoding="utf-8")) if args.plans else {}
    today = datetime.date.fromisoformat(args.date) if args.date else datetime.date.today()
    out, ver, changes, refs = apply(page, choices, order, plans, Path(args.template).read_text(encoding="utf-8"), today,
                                    args.major, len(new))
    changes = db_changes + changes + (db_notes(new, stale, has_meta) if args.db else [])
    dest = Path(args.out or args.page)
    dest.write_text(out, encoding="utf-8", newline="\n")
    print(f"Wrote {dest} as version {ver}.")
    for c in changes:
        print(f"- {c}")
    if refs:
        print("References to feature numbers outside their own cards (check each is a feature number, not e.g. a key name):")
        for r in refs:
            print(f"- {r}")
    edits = [fid for fid, ch in choices.items() if ch["edit"].strip()]
    if edits:
        print("Edits to clear once made (ArtifactData update, edit set to \"\"): " + ", ".join(edits))
    if args.files:
        copy_files(args.files)


if __name__ == "__main__":
    main()
