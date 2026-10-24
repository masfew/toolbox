"""Make or update a better-plans page without reading or editing its bookkeeping by hand.

  new SOURCE [--out PAGE] [--files FOLDER] [--date YYYY-MM-DD] [--version 1.0] [--created YYYY-MM-DD]
                 Builds a new plan page from a plan source (the format is in making.md): the title,
                 summary, extra sections, phases with their steps and statuses, and idea cards.
                 It writes everything else: the template around the content, the header with the
                 version and dates, the overview table, the progress label, phase statuses, the
                 phase and step cards, back links and the Future Ideas board. PAGE defaults to
                 SOURCE with .html; it stops without writing if the source has a mistake.
                 --files FOLDER also copies plan.css and plan.js into FOLDER, as files does.

Run on the page's HTML (the file the Artifact tool's `read` saves):

  outline PAGE   Prints a short map of the page: title, version, dates, progress, the page's
                 format, every section, phase (or planned feature), step and idea card, each with
                 its status and line numbers, so edits can go straight to the right lines.
  finish PAGE [--status N.M=done ...] [--major] [--date YYYY-MM-DD] [--out FILE] [--dry-run]
                 The bookkeeping for one republish, in one go:
                   - sets each step's status in its overview row and on its card
                   - recounts every phase card's status and the progress label
                   - bumps the version (0.1, or the next major with --major) and sets Last updated
                   - renames an older page's Future Features heading and split row to Future Ideas
                   - moves an older single-file page to the split format (styles and script in
                     plan.css and plan.js beside it), after which it's published with files
                 It prints each change it made, and stops without writing if a step isn't found.
                 --files FOLDER also copies plan.css and plan.js into FOLDER, as files does.
  files FOLDER   Copies plan.css and plan.js into FOLDER (the session's scratchpad), since the
                 Artifact tool only publishes supporting files from the working directory or
                 scratchpad, and prints the value to pass as the publish's files.
  status FILE STEP=STATUS ...
                 Writes one status record (the statuses, the time and today's date) for a
                 status-only update, which is saved as a new document in the plan's statuses
                 collection instead of republishing the page.

outline and finish take --db FOLDER, the statuses folder ArtifactData list wrote with out_dir:
outline then shows the statuses saved since the last publish, and finish writes them into the page
(each counts as one update in the version) and says which records can be deleted.

Statuses: todo (Not started), progress (In progress), done, blocked, skipped.
Steps are numbered as on the page: 1.2, F7.1.
"""

import argparse
import datetime
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))   # python -I leaves the script's own folder off the path
from apply_selections import (LABELS, FILES_NOTE, PILL, Page, block_end, copy_files, db_notes, fail,  # noqa: E402
                              fold_statuses, is_split, load_statuses, phase_status, pill, set_status, text_of,
                              wrap)

ALIASES = {"not-started": "todo", "notstarted": "todo", "in-progress": "progress", "inprogress": "progress"}


def line_of(s, i):
    return s.count("\n", 0, i) + 1


def one_line(fragment):
    return re.sub(r"\s+", " ", text_of(fragment or "")).strip()


def step_num(card_id):
    """step-1-2 -> 1.2, step-F7-1 -> F7.1"""
    return card_id[len("step-"):].replace("-", ".")


# ---------------------------------------------------------------------------------------------- outline

def outline(s):
    out = []
    t = re.search(r"<h1>(.*?)</h1>", s, re.S)
    ver = re.search(r"<dt>Version</dt><dd>([^<]*)</dd>", s)
    meta_end = s.find("</dl>")
    dates = re.findall(r'<time datetime="([^"]*)">', s[:meta_end]) if meta_end > 0 else []
    prog = re.search(r"data-progress>([^<]*)<", s)
    out.append(f"{one_line(t.group(1)) if t else '?'} | version {ver.group(1) if ver else '?'} | "
               f"created {dates[0] if dates else '?'} | updated {dates[1] if len(dates) > 1 else '?'} | "
               f"{prog.group(1) if prog else 'no progress label'} | {len(s.splitlines())} lines")
    out.append("Format: split (styles and script in plan.css and plan.js)" if is_split(s) else
               "Format: single file. finish moves it to the split format, so " + FILES_NOTE)
    summary = re.search(r'<p class="summary">([\s\S]*?)</p>', s)
    if summary:
        out.append("Summary: " + one_line(summary.group(1)))

    secs = []
    for m in re.finditer(r'<section class="block[^"]*" id="([^"]+)"[^>]*>', s):
        secs.append(f"{m.group(1)} L{line_of(s, m.start())}-{line_of(s, block_end(s, m.start(), 'section'))}")
    out.append("Sections: " + ", ".join(secs))

    # Overview rows, so a renamed step can be changed in both places.
    rows = {m.group(1): line_of(s, m.start()) for m in re.finditer(r'<td class="step" data-step="([^"]+)"', s)}

    for m in re.finditer(r'<details class="phase-card" id="phase-([^"]+)"[^>]*>', s):
        end = block_end(s, m.start(), "details")
        card = s[m.start():end]
        name = re.search(r"<h3>(.*?)</h3>", card, re.S)
        st = PILL.search(card)
        feat = re.search(r'data-feature="([^"]+)"', m.group(0))
        kind = "Feature" if feat else "Phase"
        out.append(f"{kind} {m.group(1)} {one_line(name.group(1) if name else '')} [{st.group(1) if st else '?'}] "
                   f"L{line_of(s, m.start())}-{line_of(s, end)}" + (f" id={feat.group(1)}" if feat else ""))
        for sm in re.finditer(r'<details class="step-card" id="(step-[^"]+)"[^>]*>', card):
            se = block_end(card, sm.start(), "details")
            sc = card[sm.start():se]
            sn = re.search(r"<h4>(.*?)</h4>", sc, re.S)
            sst = PILL.search(sc)
            num = step_num(sm.group(1))
            row = f" row L{rows[num]}" if num in rows else " no overview row"
            out.append(f"  {num} {one_line(sn.group(1) if sn else '')} [{sst.group(1) if sst else '?'}]"
                       f"{row}, card L{line_of(s, m.start() + sm.start())}-{line_of(s, m.start() + se)}")

    board = re.search(r'<div class="feature-board" id="feature-board">', s)
    if board:
        b_end = block_end(s, board.start(), "div")
        out.append(f"Feature board L{line_of(s, board.start())}-{line_of(s, b_end)} "
                   f"(a new idea card goes just before its closing </div> on L{line_of(s, b_end)})")
    for m in re.finditer(r'<article class="idea-card" data-feature="([^"]+)"([^>]*)>', s):
        end = block_end(s, m.start(), "article")
        name = re.search(r"<h3>(.*?)</h3>", s[m.start():end], re.S)
        dec = re.search(r'data-decision="(\w+)"', m.group(2))
        out.append(f"Idea {m.group(1)} {one_line(name.group(1)) if name else ''}"
                   f"{' [' + dec.group(1) + ']' if dec else ''} L{line_of(s, m.start())}-{line_of(s, end)}")
    return "\n".join(out)


# ---------------------------------------------------------------------------------------------- finish

def parse_status(item):
    if "=" not in item:
        fail(f"--status takes STEP=STATUS, such as 1.2=done (got {item!r})")
    num, st = (x.strip() for x in item.split("=", 1))
    st = ALIASES.get(st.lower(), st.lower())
    if st not in LABELS:
        fail(f"unknown status {st!r} for {num}: use one of {', '.join(LABELS)}")
    return num, st


def fix_phases(s, changes):
    head = re.compile(r'<details class="phase-card" id="phase-([^"]+)"[^>]*>\s*<summary class="card-head">[\s\S]*?</summary>')

    def fix(m):
        card = s[m.start():block_end(s, m.start(), "details")]
        steps = re.findall(r'class="step-card"[\s\S]*?<span class="status" data-status="(\w+)"', card)
        st = phase_status(steps)
        old = PILL.search(m.group(0))
        if not old:
            return m.group(0)
        if old.group(1) != st:
            changes.append(f"phase {m.group(1)}: {old.group(1)} -> {st}")
        return m.group(0)[:old.start()] + pill(st) + m.group(0)[old.end():]
    return head.sub(fix, s)


def fix_progress(s, changes):
    t0 = s.find('class="table overview"')
    t1 = s.find("</table>", t0)
    sts = re.findall(r'<td class="st"><span class="status" data-status="(\w+)"', s[t0:t1])
    live = [x for x in sts if x != "skipped"]
    label = f"{sum(x == 'done' for x in live)} of {len(live)} done"
    m = re.search(r'(<span class="progress" data-progress>)([^<]*)(</span>)', s)
    if not m:
        return s, label
    if m.group(2) != label:
        changes.append(f"progress: {m.group(2)} -> {label}")
    return s[:m.start()] + m.group(1) + label + m.group(3) + s[m.end():], label


def bump(s, major, today, changes, folded=0):
    m = re.search(r"<dt>Version</dt><dd>(\d+)\.(\d+)</dd>", s)
    if not m:
        fail("the page has no Version in its header")
    old = f"{m.group(1)}.{m.group(2)}"
    # Each status update folded in from the database counted as an update of its own.
    ver = f"{int(m.group(1)) + 1}.0" if major else f"{m.group(1)}.{int(m.group(2)) + 1 + folded}"
    s = s[:m.start()] + f"<dt>Version</dt><dd>{ver}</dd>" + s[m.end():]
    changes.append(f"version: {old} -> {ver}")
    d = re.search(r'(<dt>Last updated</dt><dd><time datetime=")([^"]*)(">)[^<]*(</time>)', s)
    if not d:
        fail("the page has no Last updated date in its header")
    s = s[:d.start()] + f"{d.group(1)}{today.isoformat()}{d.group(3)}{today.day} {today.strftime('%b %Y')}{d.group(4)}" + s[d.end():]
    if d.group(2) != today.isoformat():
        changes.append(f"last updated: {d.group(2)} -> {today.isoformat()}")
    return s, ver


def rename_future_features(s, changes):
    n = 0
    for old, new in (("<h2>Future Features</h2>", "<h2>Future Ideas</h2>"),
                     ('colspan="3">Future Features</th>', 'colspan="3">Future Ideas</th>')):
        n += s.count(old)
        s = s.replace(old, new)
    if n:
        changes.append("renamed Future Features to Future Ideas")
    return s


def split(s, template, changes):
    page = Page(s)
    changes.append("moved the page to the split format: " + FILES_NOTE)
    return wrap(page.content, page.title, page.styles, template)


def finish(s, statuses, major, today, template, records=None):
    changes, new, stale = [], [], []
    if records is not None:
        s, new, stale = fold_statuses(s, records, changes)
    for item in statuses:
        num, st = parse_status(item)
        s = set_status(s, num, st, changes)
    s = fix_phases(s, changes)
    s, label = fix_progress(s, changes)
    s = rename_future_features(s, changes)
    s, ver = bump(s, major, today, changes, len(new))
    if not is_split(s):
        s = split(s, template, changes)
    return s, ver, label, changes, new, stale


# ---------------------------------------------------------------------------------------------- new
# A plan source is the plan's own words with light headings, and plan.py new writes the page around them:
#   # Title                         then the summary paragraph
#   ## Section: Name {#id}          an extra section (id optional), then its content
#   ## Phase: Name {#id}            then an optional intro sentence (the phase-desc); id optional (database doc id)
#   ### Step: Name [status] {#id}   then the step body (status optional, default todo; id optional)
#   ## Idea: Name {#id}             then the one or two sentences, then any details
#   ## Styles                       plan-specific CSS, rarely needed
# Bodies are HTML; a paragraph can also be plain text, ended by a blank line.

BLOCK_TAGS = {"p", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "dl", "div", "table", "pre", "blockquote", "figure",
              "details", "svg", "hr", "img"}
VOID_TAGS = {"hr", "img"}
MARKER = re.compile(r"^(#{1,3})[ \t]+(.+?)[ \t]*$")
SECTION = re.compile(r"^section\s*:\s*(.+?)(?:\s*\{#([A-Za-z0-9_-]+)\})?$", re.I)
PHASE = re.compile(r"^phase(?:\s+\d+)?\s*:\s*(.+?)(?:\s*\{#([A-Za-z0-9_-]+)\})?$", re.I)
STEP = re.compile(r"^step(?:\s+\d+(?:\.\d+)?)?\s*:\s*(.+?)(?:\s*\[([^\]]*)\])?(?:\s*\{#([A-Za-z0-9_-]+)\})?(?:\s*\[([^\]]*)\])?$", re.I)
IDEA = re.compile(r"^idea\s*:\s*(.+?)(?:\s*\{#([A-Za-z0-9-]+)\})?$", re.I)
# Headings a source may carry that hold nothing of their own (the summary's text goes under the title).
LABEL_HEADINGS = {"summary", "plan overview", "overview", "build outline", "future ideas", "ideas", "extra sections"}
PAGE_IDS = {"overview", "overview-table", "details", "future", "feature-board"}
SOURCE_HELP = ("Use # Title, ## Section: Name, ## Phase: Name, ### Step: Name [status], ## Idea: Name or ## Styles "
               "(see Making a plan in making.md)")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", text_of(name).lower()).strip("-")


def flat(fragment):
    """Inline HTML on one line, as the page writes a summary, phase intro or idea sentence."""
    return re.sub(r"\s+", " ", fragment).strip()


def source_status(word, where):
    w = (word or "todo").strip().lower().replace(" ", "-")
    w = ALIASES.get(w, w)
    if w not in LABELS:
        fail(f"{where}: unknown status [{word}]: use one of {', '.join(LABELS)}")
    return w


def parse_source(text):
    """The source's parts, each body as (first line number, text)."""
    plan = {"title": None, "summary": [], "sections": [], "phases": [], "ideas": [], "styles": []}
    cur, unused, in_pre = plan["summary"], None, False
    for n, line in enumerate(text.splitlines(), 1):
        m = None if in_pre else MARKER.match(line)
        if m:
            level, head = len(m.group(1)), m.group(2)
            sec, ph, st, idea = (r.match(head) for r in (SECTION, PHASE, STEP, IDEA))
            if level == 1:
                if plan["title"] is not None or plan["phases"] or plan["sections"]:
                    fail(f"line {n}: a second # title. {SOURCE_HELP}")
                plan["title"] = head
                cur = plan["summary"]
            elif sec:
                plan["sections"].append({"name": sec.group(1), "id": sec.group(2), "line": n, "body": []})
                cur = plan["sections"][-1]["body"]
            elif ph:
                plan["phases"].append({"name": ph.group(1), "id": ph.group(2), "line": n, "intro": [], "steps": []})
                cur = plan["phases"][-1]["intro"]
            elif st:
                if not plan["phases"]:
                    fail(f"line {n}: step {st.group(1)!r} comes before any ## Phase: heading")
                step = {"name": st.group(1), "status": source_status(st.group(2) or st.group(4), f"line {n}"),
                        "id": st.group(3), "line": n, "body": []}
                plan["phases"][-1]["steps"].append(step)
                cur = step["body"]
            elif idea:
                plan["ideas"].append({"name": idea.group(1), "id": idea.group(2), "line": n, "body": []})
                cur = plan["ideas"][-1]["body"]
            elif head.lower() in ("styles", "style"):
                cur = plan["styles"]
            elif head.lower().rstrip(":") == "summary":
                cur = plan["summary"]
            elif head.lower().rstrip(":") in LABEL_HEADINGS:
                cur = unused = []
                unused.append((n, head))
            else:
                fail(f"line {n}: {line.strip()!r} isn't a plan source heading. {SOURCE_HELP}")
            continue
        if cur is unused and line.strip():
            fail(f"line {n}: text under ## {unused[0][1]} isn't used: {SOURCE_HELP}")
        cur.append((n, line))
        opens, closes = len(re.findall(r"<pre\b", line, re.I)), len(re.findall(r"</pre>", line, re.I))
        in_pre = (in_pre or opens > closes) and not closes > opens
    if plan["title"] is None:
        fail(f"the source has no # title line. {SOURCE_HELP}")
    if not plan["phases"]:
        fail("the source has no ## Phase: headings, so the plan has no steps")
    for ph in plan["phases"]:
        if not ph["steps"]:
            fail(f"line {ph['line']}: phase {ph['name']!r} has no ### Step: headings")
    return plan


def joined(lines):
    """(first line number, text) of a body's lines."""
    return (lines[0][0] if lines else 0), "\n".join(x for _, x in lines)


def element_end(text, i, tag, line0):
    pat = re.compile(rf"<(/?){tag}\b[^>]*?(/?)>", re.I)
    depth = 0
    for m in pat.finditer(text, i):
        if m.group(2) and not m.group(1):
            if depth == 0:
                return m.end()
            continue
        depth += -1 if m.group(1) else 1
        if depth == 0:
            return m.end()
    fail(f"line {line0 + text.count(chr(10), 0, i)}: <{tag}> is never closed")


def block_tag(s):
    t = re.match(r"<([A-Za-z][A-Za-z0-9]*)\b", s)
    return t.group(1).lower() if t and t.group(1).lower() in BLOCK_TAGS else None


def items(body):
    """A body's top-level blocks as (tag, html), each keeping its first line's indent. A run of plain text (up to a
    blank line or a line that starts with a block tag) becomes a <p>."""
    line0, text = joined(body)
    out, i = [], 0
    while True:
        m = re.compile(r"\S").search(text, i)
        if not m:
            return out
        p = m.start()
        ls = text.rfind("\n", 0, p) + 1
        ls = ls if not text[ls:p].strip() else p
        if text.startswith("<!--", p):
            e = text.find("-->", p)
            e = len(text) if e < 0 else e + 3
            out.append(("comment", text[ls:e]))
        elif block_tag(text[p:]):
            tag = block_tag(text[p:])
            e = text.index(">", p) + 1 if tag in VOID_TAGS else element_end(text, p, tag, line0)
            out.append((tag, text[ls:e]))
        else:
            e = text.find("\n", p)
            while e >= 0:
                nxt = text.find("\n", e + 1)
                s = text[e + 1:nxt if nxt >= 0 else len(text)].strip()
                if not s or s.startswith("<!--") or block_tag(s):
                    break
                e = nxt
            e = len(text) if e < 0 else e
            out.append(("p", f"<p>{flat(text[p:e])}</p>"))
        i = e


def reindent(chunk, pad):
    """The chunk's lines moved to start at pad, keeping their relative indents and anything inside <pre>."""
    lines = chunk.split("\n")
    first = len(lines[0]) - len(lines[0].lstrip())
    out, in_pre = [], False
    for ln in lines:
        if in_pre:
            out.append(ln)
        else:
            cut = min(first, len(ln) - len(ln.lstrip()))
            out.append(pad + ln[cut:].rstrip() if ln.strip() else "")
        opens, closes = len(re.findall(r"<pre\b", ln, re.I)), len(re.findall(r"</pre>", ln, re.I))
        in_pre = (in_pre or opens > closes) and not closes > opens
    return "\n".join(out)


def block_html(tag, html, pad):
    """One block at pad, with a bare table put in a .table-wrap and a bare svg in a .diagram."""
    if tag == "table":
        if not re.match(r"\s*<table\b[^>]*\bclass=", html):
            html = re.sub(r"<table\b", '<table class="table"', html, count=1)
        return f'{pad}<div class="table-wrap">\n{reindent(html, pad + "  ")}\n{pad}</div>'
    if tag == "svg":
        return f'{pad}<div class="diagram">\n{reindent(html, pad + "  ")}\n{pad}</div>'
    return reindent(html, pad)


def body_html(body, pad):
    return "\n".join(block_html(t, h, pad) for t, h in items(body))


def section_html(body, pad):
    """An extra section's content: its divs (prose, diagram, table-wrap, note) as written, and runs of other
    blocks (paragraphs, subheadings, lists) in a .prose div, as the page lays them out."""
    out, run = [], []
    for t, h in items(body) + [("end", "")]:
        if t in ("div", "table", "svg", "end"):
            if run:
                out.append(f'{pad}<div class="prose">\n' + "\n".join(reindent(x, pad + "  ") for x in run) + f"\n{pad}</div>")
                run = []
            if t != "end":
                out.append(block_html(t, h, pad))
        else:
            run.append(h)
    return "\n".join(out)


def inline_text(body, what):
    """A summary, phase intro or idea sentence: one line of inline HTML, without the <p> around it."""
    _, text = joined(body)
    text = flat(text)
    m = re.fullmatch(r"<p\b[^>]*>(.*)</p>", text, re.S)
    return m.group(1).strip() if m and "</p>" not in m.group(1) else text


def human(d):
    return f"{d.day} {d.strftime('%b %Y')}"


def build_page(plan, template, today, created, version):
    title = plan["title"]
    summary = inline_text(plan["summary"], "summary")
    if not summary:
        fail("the source has no summary: write it as a paragraph under the # title line")

    used = set(PAGE_IDS)
    sections = []
    for sec in plan["sections"]:
        sid = sec["id"] or slug(sec["name"])
        if not sid or sid in used or sid.startswith(("phase-", "step-")):
            fail(f"line {sec['line']}: section id {sid!r} is taken; give the section its own with {{#some-id}}")
        used.add(sid)
        content = section_html(sec["body"], "  ")
        if not content.strip():
            fail(f"line {sec['line']}: section {sec['name']!r} is empty (leave out sections with nothing in them)")
        sections.append(f'<section class="block block-extra" id="{sid}">\n  <h2>{sec["name"]}</h2>\n{content}\n</section>\n\n')

    rows, cards, all_st = [], [], []
    for p, ph in enumerate(plan["phases"], 1):
        sts = [s["status"] for s in ph["steps"]]
        all_st += sts
        trs, steps = [], []
        for m, s in enumerate(ph["steps"], 1):
            cell = (f'\n          <th class="phase" scope="rowgroup" rowspan="{len(sts)}" data-target="phase-{p}" tabindex="0">'
                    f'<span class="ph"><span class="ph-num">{p}</span><span class="ph-name">{ph["name"]}</span></span></th>'
                    if m == 1 else "")
            trs.append(f'        <tr data-target="step-{p}-{m}" tabindex="0">{cell}\n'
                       f'          <td class="step" data-step="{p}.{m}"><span class="sn">{p}.{m}</span> {s["name"]}</td>\n'
                       f'          <td class="st">{pill(s["status"])}</td>\n        </tr>')
            body = body_html(s["body"], " " * 12)
            if not body.strip():
                fail(f"line {s['line']}: step {s['name']!r} has no details")
            steps.append(f'''      <details class="step-card" id="step-{p}-{m}" open>
        <summary class="card-head">
          <span class="card-title"><span class="card-num">Step {p}.{m}</span><h4>{s["name"]}</h4></span>
          {pill(s["status"])}
        </summary>
        <div class="step-body">
          <div class="prose">
{body}
          </div>
          <a class="back" href="#overview">↑ Back to overview</a>
        </div>
      </details>''')
        rows.append(f'      <tbody data-phase="{p}">\n' + "\n".join(trs) + "\n      </tbody>")
        intro = inline_text(ph["intro"], "phase intro")
        desc = f'      <p class="phase-desc">{intro}</p>\n' if intro else ""
        cards.append(f'''
  <details class="phase-card" id="phase-{p}" open>
    <summary class="card-head">
      <span class="card-title"><span class="card-num">Phase {p}</span><h3>{ph["name"]}</h3></span>
      {pill(phase_status(sts))}
    </summary>
    <div class="phase-body">
{desc}''' + "\n".join(steps) + "\n    </div>\n  </details>")
    live = [x for x in all_st if x != "skipped"]
    progress = f"{sum(x == 'done' for x in live)} of {len(live)} done"

    ideas, ids = [], set()
    for idea in plan["ideas"]:
        fid = idea["id"] or slug(idea["name"])
        if not fid or fid in ids:
            fail(f"line {idea['line']}: idea id {fid!r} is taken; give the idea its own with {{#some-id}}")
        ids.add(fid)
        parts = items(idea["body"])
        if not parts or parts[0][0] != "p":
            fail(f"line {idea['line']}: idea {idea['name']!r} needs its one or two sentences first, as a paragraph")
        sentence = inline_text([(0, parts[0][1])], "idea")
        more = "\n".join(block_html(t, h, " " * 8) for t, h in parts[1:])
        more = f'\n      <div class="idea-more prose">\n{more}\n      </div>' if more else ""
        ideas.append(f'''    <article class="idea-card" data-feature="{fid}">
      <div class="idea-text">
        <h3>{idea["name"]}</h3>
        <p>{sentence}</p>
      </div>{more}
    </article>''')
    board = "\n".join(ideas) if ideas else "    <p>No future ideas yet.</p>"

    content = f'''
<header class="plan-header">
  <div class="plan-top">
    <h1>{title}</h1>
    <dl class="meta">
      <dt>Version</dt><dd>{version}</dd>
      <dt>Created</dt><dd><time datetime="{created.isoformat()}">{human(created)}</time></dd>
      <dt>Last updated</dt><dd><time datetime="{today.isoformat()}">{human(today)}</time></dd>
    </dl>
  </div>
  <p class="summary">{summary}</p>
</header>

<section class="block" id="overview">
  <div class="block-head">
    <h2>Plan Overview</h2>
    <span class="progress" data-progress>{progress}</span>
  </div>
  <div class="table-wrap">
    <table class="table overview" id="overview-table">
      <thead><tr><th scope="col">Phase</th><th scope="col">Step</th><th class="st" scope="col">Status</th></tr></thead>
''' + "\n".join(rows) + '''
    </table>
  </div>
</section>

''' + "".join(sections) + '''<section class="block" id="details">
  <h2>Build Outline</h2>
''' + "\n".join(cards) + f'''
</section>


<section class="block" id="future">
  <h2>Future Ideas</h2>
  <p class="block-intro" data-feature-hint hidden></p>
  <div class="feature-board" id="feature-board">
{board}
  </div>
</section>

'''
    _, css = joined(plan["styles"])
    styles = [f"<style>\n/* plan-specific */\n{css.strip()}\n</style>"] if css.strip() else []
    page = wrap(content, text_of(title), styles, template)
    counts = (f"{len(plan['phases'])} phase{'s' if len(plan['phases']) != 1 else ''}, {len(all_st)} step{"s" if len(all_st) != 1 else ""} ({progress}), "
              f"{len(sections)} extra section{'s' if len(sections) != 1 else ''}, {len(ideas)} idea card{'s' if len(ideas) != 1 else ''}")
    return page, counts


def new_page(src, out, today, created, version, template):
    if not re.fullmatch(r"\d+\.\d+", version):
        fail(f"--version takes a version such as 1.0 (got {version!r})")
    src = Path(src)
    dest = Path(out) if out else src.with_suffix(".html")
    if dest.resolve() == src.resolve():
        fail("the page would overwrite the source: give the source another extension, such as .txt, or pass --out")
    plan = parse_source(src.read_text(encoding="utf-8-sig"))
    page, counts = build_page(plan, template, today, created or today, version)
    with open(dest, "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    print(f"Wrote {dest}: {text_of(plan['title'])}, version {version}, {counts}.")


def write_status(dest, items):
    """Writes one status record for the database: the statuses to set, the time (which orders records from
    different sessions) and today's date (the page's Last updated)."""
    steps = {}
    for item in items:
        num, st = parse_status(item)
        steps[num] = st
    if not steps:
        fail("give at least one STEP=STATUS, such as 2.3=done")
    now = datetime.datetime.now(datetime.timezone.utc)
    body = {"steps": steps, "at": now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z",
            "date": datetime.date.today().isoformat()}
    dest = Path(dest)
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(json.dumps(body), encoding="utf-8")
    print(f"Wrote {dest}: " + ", ".join(f"{k} {v}" for k, v in steps.items()) + ". Save it as a new document in the "
          "plan's statuses collection (ArtifactData set, file_path this file).")


def db_line(s, has_meta, new, stale):
    """The outline's line about the plan's database statuses, including the records to delete after the publish."""
    if not has_meta:
        head = "Database: not set up for status records yet (no statuses/_meta); the next republish sets it up"
    else:
        head = "Database: set up for status records"
    if not new:
        head += "; no status updates newer than the page."
    else:
        head += (f"; {len(new)} status update{'s' if len(new) != 1 else ''} newer than the page, shown above: "
                 + "; ".join(f"{', '.join(f'{k} {v}' for k, v in r['steps'].items())} ({r['date']})" for r in new)
                 + ". finish --db writes them into the page.")
    if stale:
        head += (" Records the page already holds, to delete in the batch after the publish: " + ", ".join(stale) + ".")
    return head


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=["new", "outline", "finish", "files", "status"])
    ap.add_argument("page", help="the plan's HTML (the file the Artifact tool's read saved); for new, the plan source; "
                                 "for files, the folder to copy into; for status, the record file to write")
    ap.add_argument("steps", nargs="*", metavar="STEP=STATUS", help="status: the statuses to save, e.g. 2.3=done")
    ap.add_argument("--db", metavar="FOLDER", help="outline and finish: the statuses folder ArtifactData list wrote with "
                                                  "out_dir, so status records saved since the last publish are included")
    ap.add_argument("--status", nargs="*", default=[], metavar="STEP=STATUS", help="e.g. 1.2=done F7.1=progress")
    ap.add_argument("--major", action="store_true", help="steps or phases were added, removed, reordered or regrouped")
    ap.add_argument("--date", help="Last updated date, YYYY-MM-DD; default today")
    ap.add_argument("--version", default="1.0", help="new: the page's version (default 1.0), for a plan rebuilt from an older one")
    ap.add_argument("--created", help="new: the Created date, YYYY-MM-DD (default: the same as --date)")
    ap.add_argument("--out", help="where to write the page; default: overwrite it (new: the source with .html)")
    ap.add_argument("--dry-run", action="store_true", help="print the changes without writing")
    ap.add_argument("--files", metavar="FOLDER", help="also copy plan.css and plan.js into FOLDER (your scratchpad) for the publish")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")   # page text isn't always cp1252
    if a.command == "files":
        copy_files(a.page)
        return
    if a.command == "status":
        write_status(a.page, a.steps + a.status)
        return
    if a.command == "new":
        today = datetime.date.fromisoformat(a.date) if a.date else datetime.date.today()
        new_page(a.page, a.out, today, datetime.date.fromisoformat(a.created) if a.created else None, a.version,
            (HERE / "template.html").read_text(encoding="utf-8"))
        if a.files:
            copy_files(a.files)
        return
    page = Path(a.page)
    with open(page, encoding="utf-8", newline="") as f:   # keep the page's own line endings
        s = f.read()
    records, has_meta = load_statuses(a.db) if a.db else (None, True)
    if a.command == "outline":
        new, stale = [], []
        if records is not None:
            s, new, stale = fold_statuses(s, records, [])
            if new:   # so the phases and progress shown follow the folded statuses too
                s = fix_phases(s, [])
                s = fix_progress(s, [])[0]
        print(outline(s))
        if a.db:
            print(db_line(s, has_meta, new, stale))
        return
    today = datetime.date.fromisoformat(a.date) if a.date else datetime.date.today()
    s, ver, label, changes, new, stale = finish(s, a.status, a.major, today,
                                                (HERE / "template.html").read_text(encoding="utf-8"), records)
    if a.db:
        changes += db_notes(new, stale, has_meta)
    dest = Path(a.out or a.page)
    if a.dry_run:
        print(f"Dry run, nothing written: version {ver}, {label}.")
    else:
        with open(dest, "w", encoding="utf-8", newline="") as f:
            f.write(s)
        print(f"Wrote {dest}: version {ver}, {label}.")
    for c in changes:
        print(f"- {c}")
    if a.files and not a.dry_run:
        copy_files(a.files)


if __name__ == "__main__":
    main()
