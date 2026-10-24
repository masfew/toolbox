"""Make, update and read better-plans pages. Database plans (a plan/_plan entry) keep their content in the
artifact's database and every update is one new record; older plans are HTML pages updated by republishing.

Database plans (DB: the folder ArtifactData list wrote with out_dir; it holds plan/, statuses/, features/):

  record FILE [STEP=STATUS ...] [--outcome N TEXT] [--note N TEXT] [--rename T NAME] [--swap T OLD NEW]
         [--set T FIELD TEXT] [--move WHAT before|after REF] [--add SOURCE [--phase N | --after N.M | --before N.M]]
         [--takeout FEATURE [DETAILS]] [--order FEATURE ...] [--major]
                 One update as one record, saved as a new document in the statuses collection. Needs no list:
                 T is a step number (4.2, F8.1), a phase or feature number (2, F8), idea:<id>, section:<id> or
                 plan, as the plan stands now. --swap T:Heading OLD NEW swaps only under that <h5>. --set FIELD is
                 name, short, intro, desc, body, sentence, details, title or summary; TEXT may be @file (a source
                 fragment). --add takes a plan source fragment (### Step:, ## Phase:, ## Feature: Name | Short
                 {#id}, ## Section:, ## Idea:). status FILE ... is the same command.
  outline DB [--show WHAT ...] [--jobs]
                 Title, version, progress, every section, phase, step, planned feature and idea with its status
                 and doc id, records that changed nothing, and the future ideas to bring in. --show 4.2 / F8 /
                 <doc id> / idea:<id> / section:<id> prints that part's text; --jobs prints only the ideas side.
  edit DB TARGET --out OUT [--name X] [--replace OLD NEW]... [--in HEADING] [--body FILE] [--intro X]
                 [--sentence X] [--details FILE] [--short X] [--status N=S ...] [--outcome N TEXT]
                 A change to existing text, checked against the text now, as OUT/record.json.
  add SOURCE --out OUT [--db DB] [--phase N | --after N.M | --before N.M]
                 New parts as OUT/record.json; with --db the place is checked and named by id.
  move DB WHAT (--before REF | --after REF) --out OUT
                 Moves a step, phase or planned feature, as OUT/record.json.
  new SOURCE --files FOLDER [--out PAGE]
                 A new plan: the page (first snapshot) beside the source and its entries in FOLDER/seed
                 (_plan.json, _seed.json), plus plan.css and plan.js in FOLDER for the publish.
  convert PAGE OUTDIR
                 A plan page as entries: OUTDIR/plan/_plan.json and _seed.json, with every number mention made a
                 token listed, and anything the page's allowlist won't show.
  snapshot DB --out PAGE [--fold OUTDIR] [--files FOLDER]
                 The page built from the entries and records. --fold also writes the entries with the records
                 written in (OUTDIR/<doc id>.json) and prints the batch.

Older plans (an HTML page, no plan/_plan): outline PAGE [--db FOLDER], finish PAGE ..., as before (htmlplan.py).
  files FOLDER   Copies plan.css and plan.js into FOLDER for a publish.
"""

import argparse
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))   # python -I leaves the script's own folder off the path
import dbplan as db  # noqa: E402
import htmlplan as hp  # noqa: E402
from apply_selections import copy_files, fail, text_of  # noqa: E402

INLINE_FIELDS = {"name", "short", "intro", "desc", "sentence", "title", "summary"}


def model(folder):
    return db.Model(*db.load_dir(folder))


def lines_of(path):
    return list(enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1))


def notes_arg(outcomes, notes):
    out = {}
    for num, text in outcomes or []:
        out[num] = (out[num] + "\n" if num in out else "") + f"<h5>Outcome</h5>\n<p>{db.strict('--outcome', text.strip(), True)}</p>"
    for num, text in notes or []:
        body = db.strict("--note", db.norm_body([(1, x) for x in text.strip().split("\n")]))
        out[num] = (out[num] + "\n" if num in out else "") + body
    return out


def text_arg(field, value):
    """--set TEXT: inline text as it is, @file read as a source fragment."""
    if value.startswith("@"):
        lines = lines_of(value[1:])
        if field in INLINE_FIELDS:
            return db.strict(value, hp.inline_text(lines, field), True)
        return db.strict(value, hp.section_html(lines, "") if field == "section" else db.norm_body(lines))
    return db.strict("--set", value, field in INLINE_FIELDS)


def save(path, rec, what):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(rec, ensure_ascii=False), encoding="utf-8")
    print(f"Wrote {path.as_posix()}: {what}. Save it as a new document in the plan's statuses collection "
          f"(ArtifactData set, file_path this file{', or with the rest of the batch' if 'batch' in what else ''}).")


def describe(rec):
    out = [f"{k} {v}" for k, v in rec.get("steps", {}).items()]
    out += [(f"outcome on {k}" if v.startswith("<h5>Outcome</h5>") else f"note on {k}") for k, v in rec.get("notes", {}).items()]
    out += [f"rename {k}" for k in rec.get("rename", {})]
    out += [f"swap in {s['in']}" for s in rec.get("swaps", [])]
    out += [f"new text for {k}" for k in rec.get("set", {})]
    out += [f"move {mv['what']}" for mv in rec.get("moves", [])]
    for a in rec.get("add", []):
        for kind in ("phase", "feature", "section", "idea"):
            if kind in a:
                out.append(f"new {kind} {a[kind]['doc']}")
        if a.get("steps"):
            out.append(f"{len(a['steps'])} new step(s) " + ", ".join(s["doc"] for s in a["steps"]))
    out += [f"take out {k}" for k in rec.get("takeout", {})]
    if rec.get("order"):
        out.append("feature order")
    return ", ".join(out) + (" (major)" if rec.get("major") else "")


def main():
    if len(sys.argv) > 2 and (sys.argv[1] == "finish" or (sys.argv[1] == "outline" and Path(sys.argv[2]).is_file())):
        hp.main()   # an older plan: the page itself
        return
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("command", choices=["status", "record", "outline", "edit", "add", "move", "new", "convert",
                                        "snapshot", "files"])
    ap.add_argument("args", nargs="*")
    ap.add_argument("--db")
    ap.add_argument("--out")
    ap.add_argument("--show", nargs="*", default=[])
    ap.add_argument("--jobs", action="store_true")
    ap.add_argument("--phase")
    ap.add_argument("--after")
    ap.add_argument("--before")
    ap.add_argument("--name")
    ap.add_argument("--short")
    ap.add_argument("--replace", nargs=2, action="append", default=[], metavar=("OLD", "NEW"))
    ap.add_argument("--in", dest="within")
    ap.add_argument("--body")
    ap.add_argument("--details")
    ap.add_argument("--intro")
    ap.add_argument("--sentence")
    ap.add_argument("--status", nargs="*", default=[])
    ap.add_argument("--outcome", nargs=2, action="append", default=[], metavar=("STEP", "TEXT"))
    ap.add_argument("--note", nargs=2, action="append", default=[], metavar=("STEP", "TEXT"))
    ap.add_argument("--rename", nargs=2, action="append", default=[], metavar=("T", "NAME"))
    ap.add_argument("--swap", nargs=3, action="append", default=[], metavar=("T", "OLD", "NEW"))
    ap.add_argument("--set", nargs=3, action="append", default=[], metavar=("T", "FIELD", "TEXT"), dest="sets")
    ap.add_argument("--move", nargs=3, action="append", default=[], metavar=("WHAT", "WHERE", "REF"))
    ap.add_argument("--add", action="append", default=[], metavar="SOURCE")
    ap.add_argument("--takeout", nargs="+", action="append", default=[], metavar="FEATURE")
    ap.add_argument("--order", nargs="+")
    ap.add_argument("--major", action="store_true")
    ap.add_argument("--fold")
    ap.add_argument("--files")
    a = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    c, args = a.command, a.args

    if c == "files":
        copy_files(args[0])
    elif c in ("status", "record"):
        if not args:
            fail(f"{c} FILE [STEP=STATUS ...] [options]")
        steps = {}
        for item in args[1:] + a.status:
            num, st = hp.parse_status(item)
            steps[num] = st
        ops, major = {}, a.major
        for t, name in a.rename:
            ops.setdefault("rename", {})[t] = db.strict("--rename", name, True)
        for t, old, new in a.swap:
            target, _, under = _split_target(t)
            s = {"in": target, "old": old, "new": db.strict("--swap", new)}
            if under:
                s["under"] = under
            ops.setdefault("swaps", []).append(s)
        for t, field, text in a.sets:
            if field not in db.TEXT_FIELDS:
                fail(f"--set: {field} isn't a field: use one of {', '.join(db.TEXT_FIELDS)}")
            ops.setdefault("set", {}).setdefault(t, {})[field] = text_arg(field, text)
        for what, where, ref in a.move:
            if where not in ("before", "after"):
                fail("--move WHAT before|after REF")
            ops.setdefault("moves", []).append({"what": what, where: ref})
            major = True
        for src in a.add:
            adds, mj = db.add_parts(Path(src).read_text(encoding="utf-8-sig"), a.phase, a.after, a.before)
            ops.setdefault("add", []).extend(adds)
            major = major or mj
        for t in a.takeout:
            part = {}
            if len(t) > 1:
                part["details"] = db.strict(t[1], db.norm_body(lines_of(t[1])))
            ops.setdefault("takeout", {})[t[0]] = part
            major = True
        if a.order:
            ops["order"] = a.order
            major = True
        notes = notes_arg(a.outcome, a.note)
        if not steps and not notes and not ops:
            fail("give at least one STEP=STATUS, --outcome, --note or change")
        rec = db.record(steps=steps, notes=notes, major=major, **ops)
        save(args[0], rec, describe(rec))
    elif c == "outline":
        print(db.outline(model(args[0] if args else a.db), a.show, a.jobs))
    elif c == "add":
        if not a.out:
            fail("add needs --out FOLDER")
        text = Path(args[0]).read_text(encoding="utf-8-sig")
        to, after, before = a.phase, a.after, a.before
        if a.db:
            m = model(a.db)
            for ref, name in ((to, "--phase"), (after, "--after"), (before, "--before")):
                if ref and not m.resolve(ref):
                    fail(f"{name} {ref} isn't in the plan")
            to, after, before = (m.resolve(x) if x else None for x in (to, after, before))
            if after and m.E.get(after, {}).get("kind") == "phase":
                after = m.pnum[after]
        adds, major = db.add_parts(text, to, after, before)
        if a.db:
            for part in adds:
                for p in [part.get(k) for k in ("phase", "feature", "section", "idea")] + part.get("steps", []):
                    if p and p["doc"] in m.E:
                        fail(f"{p['doc']} is taken: give the part its own id with {{#another-id}} after its name")
        rec = db.record(major=major, add=adds)
        save(Path(a.out) / "record.json", rec, describe(rec))
    elif c == "edit":
        m = model(a.db or args[0])
        target = args[0] if a.db else args[1]
        did = m.resolve(target)
        if not did:
            fail(f"{target!r} isn't in the plan: give a step number, phase:N, F8, idea:<id>, section:<id>, plan or a doc id")
        doc = m.doc(did)
        kind = "plan" if did == "_plan" else doc.get("kind")
        f = m.main_field(did)
        upd = {}
        if a.name is not None:
            upd["title" if kind == "plan" else "name"] = db.strict("--name", a.name, True)
        if a.short is not None:
            upd["short"] = db.strict("--short", a.short, True)
        if a.intro is not None:
            upd["desc" if doc.get("feature") else "intro"] = db.strict("--intro", a.intro, True)
        if a.sentence is not None:
            upd["sentence"] = db.strict("--sentence", a.sentence, True)
        if a.body is not None:
            upd[f] = text_arg("section" if kind == "section" else f, "@" + a.body)
        if a.details is not None:
            upd["details"] = text_arg("details", "@" + a.details)
        for old, new in a.replace:
            text = upd.get(f, m.sub(doc.get(f, "")))
            lo, hi = 0, len(text)
            if a.within:
                hm = re.search(rf"<h([45])>\s*{re.escape(a.within)}\s*</h\1>", text, re.I)
                if not hm:
                    fail(f"no <h5>{a.within}</h5> in {did}'s {f}")
                nxt = re.compile(rf"<h[1-{hm.group(1)}]\b").search(text, hm.end())
                lo, hi = hm.end(), (nxt.start() if nxt else len(text))
            if old not in text[lo:hi]:
                fail(f"{old!r} isn't in {did}'s {f}" + (f" under {a.within}" if a.within else ""))
            upd[f] = text[:lo] + text[lo:hi].replace(old, db.strict("--replace", new)) + text[hi:]
        steps = {}
        for item in a.status:
            num, st = hp.parse_status(item)
            if not m.resolve(num):
                fail(f"step {num} isn't in the plan")
            steps[num] = st
        notes = notes_arg(a.outcome, a.note)
        if not upd and not steps and not notes:
            fail("nothing to change: give --name, --replace, --body, --intro, --sentence, --details, --status or --outcome")
        rec = db.record(steps=steps, notes=notes, set={("plan" if did == "_plan" else did): upd} if upd else None)
        save(Path(a.out) / "record.json", rec, describe(rec))
    elif c == "move":
        m = model(a.db or args[0])
        what = args[0] if a.db else args[1]
        ref = a.before or a.after
        w, r = m.resolve(what), m.resolve(ref or "")
        if not w or not r:
            fail(f"give two steps (2.3) or two phases (2, F8) that are in the plan: {what!r}, {ref!r}")
        probe = db.Model(m.raw, m.statuses, m.features)
        if not probe.move(w, r, bool(a.before)):
            fail("a step moves next to a step, a phase among phases, and a planned feature among planned features")
        rec = db.record(major=True, moves=[{"what": w, ("before" if a.before else "after"): r}])
        save(Path(a.out) / "record.json", rec, describe(rec))
    elif c == "new":
        if not a.files:
            fail("new needs --files FOLDER (your scratchpad)")
        src = Path(args[0])
        page = Path(a.out) if a.out else src.with_suffix(".html")
        if page.resolve() == src.resolve():
            fail("the page would overwrite the source: give the source another extension, such as .txt, or pass --out")
        entries, html, counts, warn = db.new_plan(src, (HERE / "template.html").read_text(encoding="utf-8"))
        page.parent.mkdir(parents=True, exist_ok=True)
        with open(page, "w", encoding="utf-8", newline="\n") as f:
            f.write(html)
        seed = Path(a.files).resolve() / "seed"
        docs = db.seed_docs(entries)
        for k, v in docs.items():
            db.write_json(seed, k, v)
        copy_files(a.files)
        print(f"Wrote {page.resolve().as_posix()}: {text_of(entries['_plan']['title'])}, version 1.0, {counts}.")
        print(f"Entries: {', '.join((seed / (k + '.json')).as_posix() for k in docs)}. After the publish, "
              "ArtifactData batch: set plan/<doc> from each file, and statuses/_meta {\"statuses\": 1}.")
        for w in warn:
            print("- warning: " + w)
    elif c == "convert":
        page, outdir = args
        s = Path(page).read_text(encoding="utf-8")
        entries, warn, refs = db.convert(s)
        entries["_plan"]["snapshotAt"] = db.now_stamp()   # the page published with these entries is a snapshot
        d = Path(outdir) / "plan"
        docs = db.seed_docs(entries)
        for k, v in docs.items():
            db.write_json(d, k, v)
        m = db.Model(docs)
        print(f"Wrote {len(entries) - 1} entries as {', '.join(docs)} in {d.as_posix()}.")
        for w in warn:
            print("- warning: " + w)
        if refs:
            print(f"- {len(refs)} step and feature number mentions became tokens (check none is a plain number):")
            for r in refs:
                print("    " + r)
        for x in db.dropped(m):
            print("- the page won't show: " + x)
    elif c == "snapshot":
        m = model(a.db or args[0])
        if not a.out:
            fail("snapshot needs --out PAGE")
        html = db.snapshot(m, (HERE / "template.html").read_text(encoding="utf-8"))
        with open(a.out, "w", encoding="utf-8", newline="\n") as f:
            f.write(html)
        print(f"Wrote {a.out}: version {m.version}.")
        if a.fold:
            F, meta = db.folded(m)
            writes = db.entry_writes(m, F)
            out = Path(a.fold)
            rid = f"r-{meta['updated'].replace('-', '')}-fold-{db.rand4()}"
            p = db.write_json(out, "fold-record", db.fold_record(m, F, meta))
            meta["snapshotAt"] = meta["bakedAt"]
            meta.pop("snapshotAuto", None)   # set by the page's automatic snapshot; this one is Claude's
            lines = [{"op": "set", "collection": "statuses", "doc_id": rid, "file_path": p.as_posix()}]
            for op, k, body in writes:
                if op == "set":
                    p = db.write_json(out, k, body)
                    lines.append({"op": "set", "collection": "plan", "doc_id": k, "file_path": p.as_posix()}
                                 | ({"if_version": "<from the list>"} if k in m.own else {}))
                else:
                    lines.append({"op": "delete", "collection": "plan", "doc_id": k, "if_version": "<from the list>"})
            p = db.write_json(out, "_plan", meta)
            lines.append({"op": "set", "collection": "plan", "doc_id": "_plan", "file_path": p.as_posix(),
                          "if_version": "<from the list>"})
            for r_id, r in sorted(m.statuses.items()):
                if not r_id.startswith("_") and isinstance(r, dict) and isinstance(r.get("at"), str) and r["at"] <= m.stamp:
                    lines.append({"op": "delete", "collection": "statuses", "doc_id": r_id, "if_version": "<from the list>"})
            lines.append({"op": "delete", "collection": "statuses", "doc_id": rid, "if_version": 1})
            print(f"Fold: {len(lines)} writes, in this order (at most 50 per batch; the fold record first, the entries, "
                  "_plan, then the records, the fold record last):")
            for x in lines:
                print("  " + json.dumps(x, ensure_ascii=False))
        for x in m.misses:
            print("- changed nothing: " + x)
        if a.files:
            copy_files(a.files)


def _split_target(t):
    """'4.2:How' -> ('4.2', 'How'); 'idea:x' -> ('idea:x', ''); 'section:risks:Options' -> ('section:risks', 'Options')."""
    low = t.lower()
    if low.startswith(("idea:", "section:", "phase:", "feature:")):
        head, _, rest = t.partition(":")
        name, _, under = rest.partition(":")
        return f"{head}:{name}", "", under
    target, _, under = t.partition(":")
    return target, "", under


if __name__ == "__main__":
    main()
