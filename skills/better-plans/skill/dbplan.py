"""Database plans: a plan's content lives in its artifact database as small entries, and the page builds itself
from them. This module is the Python side: the model (entries, records replayed in order, numbering, statuses,
version), the page builder (the same HTML plan.js builds, used for snapshots), new plans and converting a page
into entries, the records plan.py writes, and the fold a snapshot does.

Collections (see better-plans/CLAUDE.md, "Database plans"):
  plan      _plan          {kind: "plan", title, summary, version, created, updated, bakedAt, styles, snapshotAt?}
            _seed, _seed2  {entries: {doc id: entry}}: a new or converted plan's entries in one document
            p-<slug>       {kind: "phase", name, intro, sort}                     a core phase
            p-<feature id> {kind: "phase", feature, name, short, desc, sort}      a planned feature (F1, F2 ...)
            s-<slug>       {kind: "step", phase, name, body, status, sort}
            x-<id>         {kind: "section", id, name, body, sort}
            i-<feature id> {kind: "idea", feature, name, sentence, details, sort}
            A document of its own wins over the seed's entry with the same id; {deleted: true} hides one.
  statuses  one record per update, never rewritten (see Model.replay for the kinds of change a record holds);
            _meta marks the plan set up for records.
  features  the user's idea choices and edits, as before.
Numbers (2.3, F7) are never stored: they come from the sort keys. Text holds {{F:<feature id>}} and
{{S:<step doc id>}} tokens, shown as the feature's or step's current number.
"""

import copy
import datetime
import json
import random
import re
import string
from html.parser import HTMLParser
from pathlib import Path

from apply_selections import LABELS, block_end, fail, phase_status, pill, text_of, wrap
import htmlplan as hp

GAP = 1000
TOKEN = re.compile(r"\{\{([FS]):([A-Za-z0-9_-]+)\}\}")
ALIASES = {"not-started": "todo", "notstarted": "todo", "in-progress": "progress", "inprogress": "progress"}
TEXT_FIELDS = ("title", "summary", "name", "short", "intro", "desc", "sentence", "details", "body")
SEED_LIMIT = 200_000
SNAPSHOT_HINT = 30   # more live records than this and the page saves a snapshot when an editor opens it (AUTO_RECORDS in plan.js)


# ---------------------------------------------------------------------------------------------- helpers

def human(iso):
    d = datetime.date.fromisoformat(iso)
    return f"{d.day} {d.strftime('%b %Y')}"


def now_stamp():
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime("%Y-%m-%dT%H:%M:%S.") + f"{t.microsecond // 1000:03d}Z"


def reindent(chunk, pad):
    """The chunk's lines moved to start at pad (same rule as plan.py's reindent, which plan.js mirrors)."""
    return hp.reindent(chunk, pad) if chunk else ""


def dedent(x):
    """Strip the common indent (outside <pre>) and blank edge lines."""
    lines = x.strip("\n").split("\n")
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    ind = [len(ln) - len(ln.lstrip()) for ln in lines if ln.strip()]
    cut = min(ind) if ind else 0
    out, in_pre = [], False
    for ln in lines:
        out.append(ln if in_pre else ln[cut:].rstrip() if ln.strip() else "")
        opens, closes = len(re.findall(r"<pre\b", ln, re.I)), len(re.findall(r"</pre>", ln, re.I))
        in_pre = (in_pre or opens > closes) and not closes > opens
    return "\n".join(out)


def slug(name, limit=60):
    s = hp.slug(name)[:limit].strip("-")
    return s or "x"


def sortkey(item):
    return (item[1].get("sort", 0), item[0])


STATUS_RANK = {"done": 0, "progress": 1, "blocked": 1, "todo": 2, "skipped": 3}


def load_dir(db):
    """plan, statuses and features documents from the folders ArtifactData list wrote (out_dir db)."""
    p = Path(db)

    def coll(name):
        d = p / name
        out = {}
        for f in sorted(d.glob("*.json")) if d.is_dir() else []:
            out[f.stem] = json.loads(f.read_text(encoding="utf-8"))
        return out
    return coll("plan"), coll("statuses"), coll("features")


def overlay(docs):
    """The entries: the seed documents' entries, then every entry document over them (a {deleted: true} document
    hides the entry). Returns (entries, own ids, seeded ids)."""
    base, seeded = {}, set()
    for k in sorted(k for k in docs if k.startswith("_seed")):
        ent = (docs[k] or {}).get("entries") or {}
        for e, v in ent.items():
            if isinstance(v, dict):
                base[e] = v
                seeded.add(e)
    own = set()
    for k in sorted(docs):
        v = docs[k]
        if k.startswith("_") or not isinstance(v, dict):
            continue
        own.add(k)
        if v.get("deleted"):
            base.pop(k, None)
        else:
            base[k] = v
    return base, own, seeded


def is_record(rid, r, baked_at):
    return (not rid.startswith("_") and isinstance(r, dict) and isinstance(r.get("at"), str) and r["at"] > baked_at)


# ---------------------------------------------------------------------------------------------- step and feature numbers in text
# Mentions of a step (F7.2, 3.6) or a planned feature (F7) are stored as tokens, so they follow it when the numbers
# change. plan.js has the same rules (tokenize there); keep the two in step.

REFNUM = re.compile(r"(F?)([0-9]+)(?:\.([0-9]+))?")
SKIP_TAGS = {"code", "pre", "svg", "kbd", "script", "style"}
UNITS = re.compile(r"^\s*(?:%|×|x\b|k\b|h\b|s\b|ms\b|days?\b|weeks?\b|months?\b|years?\b|hours?\b|hrs?\b|minutes?\b|"
                   r"mins?\b|seconds?\b|secs?\b|times\b|px\b|pt\b|em\b|rem\b|fps\b|[kmg]?hz\b|[kmgt]i?b\b|tokens?\b|"
                   r"points?\b|pts\b|stars?\b|°)", re.I)
BEFORE = re.compile(r"(?:\b(?:versions?|ver|release|python|node|chrome|ios|android|windows|macos|opus|sonnet|haiku|"
                    r"claude|gpt|api|sdk|about|around|roughly|approximately|approx|nearly|almost|over|under|than|"
                    r"rated|scored?|rating|average|avg|median|mean|costs?|price)\.?|[~≈×$£€]|→|->|←|<-|=>)\s*$", re.I)
AFTER_ARROW = re.compile(r"^\s*(?:→|->|←|<-|=>)")
PREV_F = re.compile(r"[A-Za-z0-9_@{:]")
PREV_CORE = re.compile(r"[A-Za-z0-9_.$#/\\-]")
NEXT_F = re.compile(r"[A-Za-z0-9_]")
NEXT_CORE = re.compile(r"[A-Za-z0-9_%]")
DIGIT = re.compile(r"[0-9]")


def ref_tokens(seg, id_of, fids, found=None):
    """seg (text outside tags) with step and feature mentions as tokens. id_of: number -> step doc id;
    fids: "F7" -> feature id. found collects (mention, token)."""
    out, i = [], 0
    for m in REFNUM.finditer(seg):
        s, e = m.span()
        f, n, k = m.group(1), m.group(2), m.group(3)
        prev = seg[s - 1] if s else ""
        nxt = seg[e] if e < len(seg) else ""
        nxt2 = seg[e + 1] if e + 1 < len(seg) else ""
        dotted = nxt == "." and DIGIT.match(nxt2)
        rep = None
        if f:
            if not PREV_F.match(prev or " ") and not NEXT_F.match(nxt or " ") and not dotted:
                if k is not None and f"F{n}.{k}" in id_of:
                    rep = "{{S:" + id_of[f"F{n}.{k}"] + "}}"
                elif f"F{n}" in fids:
                    rep = "{{F:" + fids[f"F{n}"] + "}}" + (f".{k}" if k is not None else "")
        elif k is not None:
            num = f"{n}.{k}"
            if (num in id_of and not PREV_CORE.match(prev or " ") and not NEXT_CORE.match(nxt or " ") and not dotted
                    and not UNITS.match(seg[e:e + 16]) and not BEFORE.search(seg[max(0, s - 16):s])
                    and not AFTER_ARROW.match(seg[e:e + 6])):
                rep = "{{S:" + id_of[num] + "}}"
        if rep:
            out.append(seg[i:s])
            out.append(rep)
            if found is not None:
                found.append((m.group(0), rep))
            i = e
    out.append(seg[i:])
    return "".join(out)


def tokenize_html(text, id_of, fids, found=None):
    """Mentions in text, outside tags and outside <code>, <pre>, <kbd> and <svg>, as tokens."""
    if not text:
        return text or ""
    parts = re.split(r"(<[^>]*>)", text)
    depth = 0
    for j in range(len(parts)):
        if j % 2:
            t = re.match(r"<(/?)([A-Za-z][A-Za-z0-9]*)", parts[j])
            if t and t.group(2).lower() in SKIP_TAGS:
                if t.group(1):
                    depth = max(0, depth - 1)
                elif not parts[j].endswith("/>"):
                    depth += 1
        elif not depth and parts[j]:
            parts[j] = ref_tokens(parts[j], id_of, fids, found)
    return "".join(parts)


# ---------------------------------------------------------------------------------------------- the allowlist
# What the page shows of an entry's HTML (plan.js cleanFragment). check_html lists what the page would drop, so new
# text can be fixed before it's saved and a converted plan says what won't show.

INLINE_TAGS = set("a b br code em i kbd s small strong sub sup span".split())
CONTENT_TAGS = INLINE_TAGS | set("p h4 h5 h6 ul ol li div table thead tbody tfoot tr th td pre blockquote hr dl dt dd "
                                 "svg g defs marker path rect circle ellipse line polyline polygon text tspan".split())
DROP_TAGS = set("script style iframe object embed template noscript foreignobject math link meta title form input "
                "button textarea select img video audio source use image animate set animatetransform "
                "animatemotion".split())
CONTENT_CLASSES = set("prose note note-label diagram table-wrap table d-box d-main d-edge d-head d-name d-sub "
                      "d-main-sub".split())
ATTRS = set("class href target rel viewbox role aria-label x y width height rx ry d cx cy r x1 y1 x2 y2 points text-anchor "
            "dominant-baseline marker-end marker-start marker-mid refx refy markerwidth markerheight orient transform "
            "colspan rowspan scope".split())


def allowed_value(name, value):
    if name == "href":
        return bool(re.fullmatch(r"#[\w-]*", value) or re.fullmatch(r"https://[^\s\"'<>]+", value))
    if name == "id":
        return bool(re.fullmatch(r"[A-Za-z][\w-]*", value))
    if name == "target":
        return value == "_blank"
    if name == "rel":
        return bool(re.fullmatch(r"(noopener|noreferrer|nofollow)( (noopener|noreferrer|nofollow))*", value))
    if name.startswith("marker-"):
        return bool(re.fullmatch(r"url\(#[\w-]+\)", value))
    if name == "transform":
        return bool(re.fullmatch(r"[\w\s.,()+-]*", value))
    if name in ("d", "points", "viewbox"):
        return bool(re.fullmatch(r"[\w\s.,+-]*", value))
    return not re.search(r"[<>]|javascript:|url\(|expression", value, re.I)


class _Checker(HTMLParser):
    def __init__(self, inline):
        super().__init__(convert_charrefs=True)
        self.tags = INLINE_TAGS if inline else CONTENT_TAGS
        self.dropped, self.depth_drop = [], 0

    def handle_starttag(self, tag, attrs):
        t = tag.lower()
        if t in DROP_TAGS:
            self.dropped.append(f"<{t}> (and what's inside it)")
            return
        if t not in self.tags:
            self.dropped.append(f"<{t}> tag (its text stays)")
            return
        for name, value in attrs:
            n, v = name.lower(), value or ""
            if not (n in ATTRS or (n == "id" and t == "marker")):
                self.dropped.append(f'{n}="{v[:30]}" on <{t}>')
            elif not allowed_value(n, v):
                self.dropped.append(f'{n}="{v[:40]}" on <{t}>')
            elif n == "class":
                bad = [c for c in v.split() if c not in CONTENT_CLASSES]
                if bad:
                    self.dropped.append(f"class {' '.join(bad)} on <{t}>")


def check_html(text, inline=False):
    """What the page's allowlist would drop from this entry text (empty when it all shows)."""
    if not text or "<" not in text:
        return []
    c = _Checker(inline)
    c.feed(TOKEN.sub("1", text))
    c.close()
    return c.dropped


def check_entry(doc_id, body):
    out = []
    for f in TEXT_FIELDS:
        v = body.get(f)
        if isinstance(v, str):
            for d in check_html(v, inline=f not in ("body", "details")):
                out.append(f"{doc_id}.{f}: {d}")
    return out


# ---------------------------------------------------------------------------------------------- the model

class Model:
    """The plan as the page shows it: the entries (seed and entry documents), then every record newer than
    _plan.bakedAt replayed in time order. plan.js does the same (buildModel there); keep the two in step."""

    def __init__(self, plan, statuses=None, features=None):
        self.raw, self.statuses, self.features = plan, statuses or {}, features or {}
        if not plan.get("_plan"):
            fail("the plan collection has no _plan entry (list the plan collection with out_dir first)")
        self.base, self.own, self.seeded = overlay(plan)
        self.E = copy.deepcopy(self.base)
        self.M = copy.deepcopy(plan["_plan"])
        self.number()
        self.replay()

    # Numbers, from the order and the statuses. Phases go done, then in progress or blocked, then not started, then
    # skipped (core phases among themselves, planned features among themselves), in their stored order within each,
    # so a status change can renumber them. self.live is the replay's statuses; before it, the entries' own. Moves and
    # adds place things by the stored order (stored_phases, stored_feats). plan.js's number does the same.
    # Only plans whose _plan has statusOrder sort: records written before it name steps by the stored order's numbers,
    # so a plan turns it on at a snapshot (folded), once those records are written into the entries.
    def number(self):
        items = sorted(((k, v) for k, v in self.E.items()), key=sortkey)
        self.steps = {}
        for k, v in items:
            if v.get("kind") == "step":
                self.steps.setdefault(v.get("phase"), []).append((k, v))
        def rank(item):
            return self.rank_of(item[0])
        self.stored_phases = [(k, v) for k, v in items if v.get("kind") == "phase" and not v.get("feature")]
        self.stored_feats = [(k, v) for k, v in items if v.get("kind") == "phase" and v.get("feature")]
        by_status = bool(self.M.get("statusOrder"))
        self.phases = sorted(self.stored_phases, key=rank) if by_status else list(self.stored_phases)
        self.feats = sorted(self.stored_feats, key=rank) if by_status else list(self.stored_feats)
        planned = {v["feature"] for _, v in self.feats}
        self.sections = [(k, v) for k, v in items if v.get("kind") == "section"]
        self.all_ideas = [(k, v) for k, v in items if v.get("kind") == "idea"]
        self.ideas = [(k, v) for k, v in self.all_ideas if v.get("feature") not in planned]
        self.num_of, self.id_of, self.pnum, self.fnum, self.fids = {}, {}, {}, {}, {}
        for p, (pid, _) in enumerate(self.phases, 1):
            self.pnum[pid] = str(p)
            for m, (sid, _) in enumerate(self.steps.get(pid, []), 1):
                self.num_of[sid], self.id_of[f"{p}.{m}"] = f"{p}.{m}", sid
        for n, (pid, ph) in enumerate(self.feats, 1):
            self.pnum[pid] = f"F{n}"
            self.fnum[ph["feature"]] = f"F{n}"
            self.fids[f"F{n}"] = ph["feature"]
            for m, (sid, _) in enumerate(self.steps.get(pid, []), 1):
                self.num_of[sid], self.id_of[f"F{n}.{m}"] = f"F{n}.{m}", sid
        self.orphans = [sid for ph, lst in self.steps.items() if ph not in self.pnum for sid, _ in lst]

    def rank_of(self, pid):
        live = getattr(self, "live", None)
        sts = [live[sid] if live is not None and sid in live else (v.get("status") if v.get("status") in LABELS else "todo")
               for sid, v in self.steps.get(pid, [])]
        return STATUS_RANK[phase_status(sts)]

    # A phase whose status group a record (with stay) changed moves only as far as it must: up to the end of its new
    # group, or down to the top of it. Its sort key changes, so the stored order stays the order shown and later
    # moves, adds and status changes start from what the page showed. plan.js's settle does the same.
    def settle(self, shown, old):
        now = {pid: self.rank_of(pid) for pid, _ in shown}
        up = [(pid, v) for pid, v in shown if now[pid] < old[pid]]
        down = [(pid, v) for pid, v in shown if now[pid] > old[pid]][::-1]
        for pid, v in up + down:
            keys = [o.get("sort", 0) for k, o in shown if k != pid and now[k] == now[pid]]
            if keys:
                v["sort"] = max(keys) + GAP if now[pid] < old[pid] else min(keys) - GAP

    def baked_statuses(self):
        return {sid: (v.get("status") if v.get("status") in LABELS else "todo")
                for lst in self.steps.values() for sid, v in lst}

    # ------------------------------------------------------------------------------------------ the records
    def replay(self):
        """Statuses, notes, structure and text after the records newer than _plan.bakedAt, in time order.
        A record may hold:
          steps    {"2.3": "done"}             statuses, by number (or step doc id)
          notes    {"2.3": html}               added at the end of the step (an Outcome, added context)
          set      {target: {field: text}}     replaces fields: name, short, intro, desc, body, sentence, details,
                                               and title or summary on "plan"
          rename   {target: "New Name"}
          swaps    [{in, old, new, under?}]    word swaps in the target's main text (or its name)
          takeout  {feature id: {details?}}    a planned feature back to an idea card
          add      [part]                      new steps, phases, planned features, sections and ideas
          moves    [{what, before | after}]    a step, phase or planned feature
          order    [feature ids]               the planned features in this order (a drag on the page)
          major    true                        the next major version instead of +0.1
          stay     true                        a phase or planned feature whose status group the steps change moves
                                               to the end of its new group (going up) or the top (going down), by
                                               a new sort key (settle); records without it leave the keys alone
          checkpoint {entries?: {id: entry | null}, meta?: {title, summary}, steps: {id: status},
                      notes: {id: [html]}}     the plan as it stood: entries replaced (null: gone), then statuses
                                               and notes reset by id. Everything in the records before the last
                                               checkpoint is in it, so they're skipped. A snapshot writes one
                                               (with fold: true, which isn't an update) before it writes the
                                               entries, so the page shows the same plan at every point of it.
        Targets and step keys are numbers as the plan stood just before the record (4.2, F8, 2, F8.1, phase:2,
        idea:<id>, section:<id>, plan) or entry doc ids. A record's text may use plain numbers: they're stored
        as tokens of the steps they named then. In the parts an add makes, a number the plan didn't have yet
        names what has it after the record (a new feature's text naming its own steps)."""
        baked_at = self.M.get("bakedAt") or ""
        recs = sorted(((k, v) for k, v in self.statuses.items() if is_record(k, v, baked_at)),
                      key=lambda r: (r[1]["at"], r[0]))
        last_cp = max([i for i, (_, r) in enumerate(recs) if isinstance(r.get("checkpoint"), dict)], default=-1)
        status, notes = self.baked_statuses(), {}
        self.live = status
        self.misses = []
        m = re.fullmatch(r"(\d+)\.(\d+)", str(self.M.get("version", "1.0")))
        maj, mnr = (int(m.group(1)), int(m.group(2))) if m else (1, 0)
        last = self.M.get("updated") or ""
        for i, (rid, r) in enumerate(recs):
            cp = r.get("checkpoint")
            if i == last_cp and isinstance(cp.get("entries"), dict):
                for k, v in cp["entries"].items():
                    if v is None:
                        self.E.pop(k, None)
                    elif isinstance(v, dict):
                        self.E[k] = copy.deepcopy(v)
                for f, v in (cp.get("meta") or {}).items():
                    if f in ("title", "summary") and isinstance(v, str):
                        self.M[f] = v
                self.number()
            if isinstance(cp, dict):
                status = self.baked_statuses()
                self.live = status
                for sid, st in (cp.get("steps") or {}).items():
                    if sid in status and st in LABELS:
                        status[sid] = st
                self.number()
                notes = {sid: [h for h in v if isinstance(h, str)] for sid, v in (cp.get("notes") or {}).items()
                         if isinstance(v, list)}
            if i >= last_cp:
                self.apply_record(rid, r, status, notes, structural=i > last_cp)
            if r.get("fold"):
                continue
            if r.get("major"):
                maj, mnr = maj + 1, 0
            else:
                mnr += 1
            day = r.get("date") if isinstance(r.get("date"), str) and re.fullmatch(r"\d{4}-\d\d-\d\d", r["date"]) else r["at"][:10]
            last = max(last, day)
        self.status = {sid: status.get(sid, st) for sid, st in self.baked_statuses().items()}
        self.notes = {sid: v for sid, v in notes.items() if sid in self.status and v}
        self.records = recs
        self.version = f"{maj}.{mnr}"
        self.updated = last
        self.stamp = recs[-1][1]["at"] if recs else baked_at

    def resolve(self, ref):
        t = str(ref).strip()
        if t == "plan":
            return "_plan"
        if t in self.E:
            return t
        if t in self.id_of:
            return self.id_of[t]
        u = t.upper()
        if u.startswith("PHASE:"):
            u = u[6:]
        for pid, n in self.pnum.items():
            if n == u:
                return pid
        low = t.lower()
        if low.startswith("idea:"):
            if "i-" + t[5:] in self.E:
                return "i-" + t[5:]
            if self.E.get(t[5:], {}).get("kind") == "idea":   # the doc id the outline prints, [i-x]
                return t[5:]
        if low.startswith("feature:"):
            for pid, ph in self.feats:
                if ph["feature"] == t[8:]:
                    return pid
        if low.startswith("section:"):
            for k, v in self.sections:
                if v.get("id") == t[8:] or k == t[8:]:
                    return k
        # A name, when exactly one phase, planned feature, step, section or idea has it.
        named = [k for k in sorted(self.E) if self.E[k].get("kind") in ("phase", "step", "section", "idea")
                 and text_of(self.sub(self.E[k].get("name", ""))).lower() == low]
        return named[0] if len(named) == 1 else None

    def main_field(self, did):
        if did == "_plan":
            return "summary"
        d = self.E[did]
        return {"step": "body", "section": "body", "idea": "details"}.get(d.get("kind")) or (
            "desc" if d.get("feature") else "intro")

    def doc(self, did):
        return self.M if did == "_plan" else self.E.get(did)

    def apply_record(self, rid, r, status, notes, structural):
        id_of, fids = dict(self.id_of), dict(self.fids)

        def tok(text):
            return tokenize_html(text, id_of, fids) if isinstance(text, str) else ""

        def step_id(key):
            sid = self.id_of.get(key) or (key if self.E.get(key, {}).get("kind") == "step" else None)
            if not sid:
                self.misses.append(f"{rid}: no step {key}")
            return sid
        st_ids = [(step_id(k), v) for k, v in (r.get("steps") or {}).items() if isinstance(k, str)]
        note_ids = [(step_id(k), v) for k, v in (r.get("notes") or {}).items() if isinstance(k, str)]
        if structural:
            changed = False
            refs = {}

            def target(ref):
                if ref not in refs:
                    refs[ref] = self.resolve(ref)
                return refs[ref]
            # Resolve every target against the numbers before this record.
            sets = [(target(t), t, v) for t, v in (r.get("set") or {}).items() if isinstance(v, dict)]
            renames = [(target(t), t, v) for t, v in (r.get("rename") or {}).items() if isinstance(v, str)]
            swaps = [(target(s.get("in", "")), s) for s in (r.get("swaps") or []) if isinstance(s, dict)]
            moves = [(target(mv.get("what", "")), target(mv.get("before") or mv.get("after") or ""), bool(mv.get("before")), mv)
                     for mv in (r.get("moves") or []) if isinstance(mv, dict)]
            adds = [a for a in (r.get("add") or []) if isinstance(a, dict)]
            add_refs = [(target(a["to"]) if a.get("to") else None, target(a["after"]) if a.get("after") else None,
                         target(a["before"]) if a.get("before") else None) for a in adds]
            for did, t, fields in sets:
                d = self.doc(did) if did else None
                if d is None:
                    self.misses.append(f"{rid}: set on {t}: not in the plan")
                    continue
                for f, v in fields.items():
                    if f in TEXT_FIELDS and isinstance(v, str) and (f in ("title", "summary")) == (did == "_plan"):
                        d[f] = tok(v)
            for did, t, name in renames:
                d = self.doc(did) if did else None
                if d is None:
                    self.misses.append(f"{rid}: rename of {t}: not in the plan")
                    continue
                f = "title" if did == "_plan" else "name"
                if d.get("feature") and d.get("kind") == "phase" and d.get("short") == d.get("name"):
                    d["short"] = tok(name)
                d[f] = tok(name)
            for did, s in swaps:
                if not (did and self.doc(did) is not None and self.swap(did, s, tok)):
                    self.misses.append(f"{rid}: {s.get('in')}: {s.get('old')!r} isn't there"
                                       + (f" under {s['under']}" if s.get("under") else ""))
            for fid, part in (r.get("takeout") or {}).items():
                self.take_out(fid, part if isinstance(part, dict) else {}, tok)
                changed = True
            fresh = []
            for a, (to, after, before) in zip(adds, add_refs):
                self.add_part(rid, a, to, after, before, tok, status, fresh)
                changed = True
            for what, ref, is_before, mv in moves:
                if self.move(what, ref, is_before):
                    changed = True
                else:
                    self.misses.append(f"{rid}: move {mv.get('what')} {'before' if is_before else 'after'} "
                                       f"{mv.get('before') or mv.get('after')}: can't")
            order = r.get("order")
            if isinstance(order, list):
                self.reorder([x for x in order if isinstance(x, str)])
                changed = True
            if changed:
                self.number()
            if fresh:
                # The parts this record added may name themselves ("passed in F1.1"): a number the plan didn't
                # have before the record means what it is after it. Numbers it had keep their old meaning.
                id_new, fids_new = {**self.id_of, **id_of}, {**self.fids, **fids}
                for did, raw in fresh:
                    for f, v in raw.items():
                        self.E[did][f] = tokenize_html(v, id_new, fids_new) if isinstance(v, str) else ""
            for sid in [s for s in status if s not in self.num_of]:
                status.pop(sid)
            for lst in self.steps.values():
                for sid, v in lst:
                    status.setdefault(sid, v.get("status") if v.get("status") in LABELS else "todo")
        shown = [list(self.phases), list(self.feats)] if st_ids and r.get("stay") and self.M.get("statusOrder") else None
        old = {pid: self.rank_of(pid) for lst in shown for pid, _ in lst} if shown else {}
        for sid, st in st_ids:
            if sid and sid in status and st in LABELS:
                status[sid] = st
        for sid, h in note_ids:
            if sid and isinstance(h, str):
                notes.setdefault(sid, []).append(tok(h))
        for lst in shown or []:
            self.settle(lst, old)
        if st_ids:
            self.number()   # the new statuses may move phases

    def swap(self, did, s, tok):
        d, f = self.doc(did), self.main_field(did)
        old, new, under = s.get("old"), s.get("new"), s.get("under")
        if not isinstance(old, str) or not old or not isinstance(new, str):
            return False
        text = self.sub(d.get(f) or "")
        a, b = 0, len(text)
        if under:
            hm = re.search(r"<h([45])>\s*" + re.escape(under) + r"\s*</h\1>", text, re.I)
            if not hm:
                return False
            nxt = re.compile(r"<h[1-" + hm.group(1) + r"]\b").search(text, hm.end())
            a, b = hm.end(), (nxt.start() if nxt else len(text))
        if old in text[a:b]:
            d[f] = tok(text[:a] + text[a:b].replace(old, new) + text[b:])
            return True
        nf = "title" if did == "_plan" else "name"
        name = self.sub(d.get(nf) or "")
        if not under and old in name:
            d[nf] = tok(name.replace(old, new))
            return True
        return False

    def take_out(self, fid, part, tok):
        pid = next((k for k, v in self.E.items() if v.get("kind") == "phase" and v.get("feature") == fid), None)
        if not pid:
            return
        ph = self.E.pop(pid)
        for k in [k for k, v in self.E.items() if v.get("kind") == "step" and v.get("phase") == pid]:
            self.E.pop(k)
        iid = "i-" + fid
        details = tok(part.get("details")) if isinstance(part.get("details"), str) else None
        if iid in self.E:
            if details is not None:
                self.E[iid]["details"] = details
        else:
            keys = [v.get("sort", 0) for v in self.E.values() if v.get("kind") == "idea"]
            self.E[iid] = {"kind": "idea", "feature": fid, "name": ph.get("name", ""), "sentence": ph.get("desc") or "",
                           "details": details or "", "sort": (max(keys) if keys else 0) + GAP}

    def free_id(self, doc, name):
        """doc, or doc-2, doc-3 … when another entry has it; None when this part is already there (same name)."""
        d, n = doc, 2
        while d in self.E:
            if self.E[d].get("name") == name:
                return None
            d, n = f"{doc}-{n}", n + 1
        return d

    def add_part(self, rid, a, to, after, before, tok, status, fresh):
        """fresh collects (doc id, {field: the record's text}) for each new entry, tokenized again once the
        record's numbers are known."""
        def last_key(kind_test):
            keys = [v.get("sort", 0) for v in self.E.values() if kind_test(v)]
            return max(keys) if keys else 0

        def put_steps(pid, steps, lo, hi):
            steps = [s for s in steps if isinstance(s, dict) and isinstance(s.get("doc"), str)]
            n = len(steps)
            for j, s in enumerate(steps):
                name = tok(s.get("name", ""))
                sid = self.free_id(s["doc"], name)
                if not sid:
                    continue
                if hi is None:
                    key = (lo or 0) + GAP * (j + 1)
                elif lo is None:
                    key = hi - GAP * (n - j)
                else:
                    key = lo + (hi - lo) * (j + 1) / (n + 1)
                st = s.get("status") if s.get("status") in LABELS else "todo"
                self.E[sid] = {"kind": "step", "phase": pid, "name": name, "body": tok(s.get("body", "")),
                               "status": st, "sort": key}
                status[sid] = st
                fresh.append((sid, {"name": s.get("name", ""), "body": s.get("body", "")}))
        steps = a.get("steps") or []
        if isinstance(a.get("phase"), dict) or isinstance(a.get("feature"), dict):
            feat = isinstance(a.get("feature"), dict)
            p = a["feature"] if feat else a["phase"]
            if not isinstance(p.get("doc"), str):
                return
            name = tok(p.get("name", ""))
            pid = self.free_id(p["doc"], name)
            if pid is None:
                pid = p["doc"]
            else:
                if feat:
                    fid = p.get("feature") or pid[2:]
                    key = last_key(lambda v: v.get("kind") == "phase" and v.get("feature")) + GAP
                    self.E[pid] = {"kind": "phase", "feature": fid, "name": name,
                                   "short": tok(p.get("short") or p.get("name", "")), "desc": tok(p.get("desc") or ""),
                                   "sort": key}
                    fresh.append((pid, {"name": p.get("name", ""), "short": p.get("short") or p.get("name", ""),
                                        "desc": p.get("desc") or ""}))
                else:
                    lst = self.stored_phases
                    if after and after in self.pnum and not self.E[after].get("feature"):
                        i = [k for k, _ in lst].index(after)
                        lo, hi = lst[i][1]["sort"], (lst[i + 1][1]["sort"] if i + 1 < len(lst) else None)
                        key = between(lo, hi)
                    else:
                        key = last_key(lambda v: v.get("kind") == "phase" and not v.get("feature")) + GAP
                    self.E[pid] = {"kind": "phase", "name": name, "intro": tok(p.get("intro") or ""), "sort": key}
                    fresh.append((pid, {"name": p.get("name", ""), "intro": p.get("intro") or ""}))
            existing = [v.get("sort", 0) for v in self.E.values() if v.get("kind") == "step" and v.get("phase") == pid]
            put_steps(pid, steps, max(existing) if existing else None, None)
        elif isinstance(a.get("section"), dict):
            p = a["section"]
            if isinstance(p.get("doc"), str) and self.free_id(p["doc"], tok(p.get("name", ""))):
                did = self.free_id(p["doc"], tok(p.get("name", "")))
                self.E[did] = {"kind": "section", "id": p.get("id") or did[2:], "name": tok(p.get("name", "")),
                               "body": tok(p.get("body", "")), "sort": last_key(lambda v: v.get("kind") == "section") + GAP}
                fresh.append((did, {"name": p.get("name", ""), "body": p.get("body", "")}))
        elif isinstance(a.get("idea"), dict):
            p = a["idea"]
            if isinstance(p.get("doc"), str) and self.free_id(p["doc"], tok(p.get("name", ""))):
                did = self.free_id(p["doc"], tok(p.get("name", "")))
                self.E[did] = {"kind": "idea", "feature": p.get("feature") or did[2:], "name": tok(p.get("name", "")),
                               "sentence": tok(p.get("sentence", "")), "details": tok(p.get("details", "")),
                               "sort": last_key(lambda v: v.get("kind") == "idea") + GAP}
                fresh.append((did, {"name": p.get("name", ""), "sentence": p.get("sentence", ""),
                                    "details": p.get("details", "")}))
        else:
            ref = after or before
            if ref and self.E.get(ref, {}).get("kind") == "step":
                pid = self.E[ref]["phase"]
                lst = self.steps.get(pid, [])
                ids = [k for k, _ in lst]
                if ref in ids:
                    i = ids.index(ref)
                    if after:
                        lo, hi = lst[i][1]["sort"], (lst[i + 1][1]["sort"] if i + 1 < len(lst) else None)
                    else:
                        lo, hi = (lst[i - 1][1]["sort"] if i > 0 else None), lst[i][1]["sort"]
                    put_steps(pid, steps, lo, hi)
                    return
            if to and self.E.get(to, {}).get("kind") == "phase":
                existing = [v.get("sort", 0) for v in self.E.values() if v.get("kind") == "step" and v.get("phase") == to]
                put_steps(to, steps, max(existing) if existing else None, None)
                return
            self.misses.append(f"{rid}: new steps with no phase to go in ({a.get('to') or a.get('after') or a.get('before')})")

    def move(self, what, ref, before):
        if not what or not ref or what == ref:
            return False
        d, t = self.E.get(what), self.E.get(ref)
        if not d or not t or d.get("kind") != t.get("kind") or d.get("kind") not in ("step", "phase"):
            return False
        if d["kind"] == "step":
            pid = t["phase"]
            lst = [x for x in self.steps.get(pid, []) if x[0] != what]
        else:
            if bool(d.get("feature")) != bool(t.get("feature")):
                return False
            lst = [x for x in (self.stored_feats if d.get("feature") else self.stored_phases) if x[0] != what]
        ids = [k for k, _ in lst]
        if ref not in ids:
            return False
        i = ids.index(ref)
        if before:
            lo, hi = (lst[i - 1][1]["sort"] if i > 0 else None), lst[i][1]["sort"]
        else:
            lo, hi = lst[i][1]["sort"], (lst[i + 1][1]["sort"] if i + 1 < len(lst) else None)
        d["sort"] = between(lo, hi)
        if d["kind"] == "step":
            d["phase"] = pid
        self.number()
        return True

    def reorder(self, order):
        """The named planned features (feature ids or doc ids) take the places they hold now, in this order."""
        byf = {}
        for pid, ph in self.feats:
            byf[ph["feature"]] = pid
            byf[pid] = pid
        chosen = []
        for x in order:
            pid = byf.get(x)
            if pid and pid not in chosen:
                chosen.append(pid)
        keys = sorted(self.E[pid].get("sort", 0) for pid in chosen)
        for pid, key in zip(chosen, keys):
            self.E[pid]["sort"] = key

    # Text: tokens shown as current numbers.
    def sub(self, text):
        return TOKEN.sub(lambda m: (self.fnum.get(m.group(2), "F?") if m.group(1) == "F"
                                    else self.num_of.get(m.group(2), "?")), text or "")

    def tokenize(self, text, found=None):
        return tokenize_html(text, self.id_of, self.fids, found)

    def phase_steps(self, pid):
        return self.steps.get(pid, [])

    def live_records(self):
        return [rid for rid, _ in self.records]


def between(lo, hi):
    if lo is None and hi is None:
        return GAP
    if lo is None:
        return hi - GAP
    if hi is None:
        return lo + GAP
    return (lo + hi) / 2


# ---------------------------------------------------------------------------------------------- the page builder
# plan.js builds the same content from the same entries (buildContent there); keep the two in step.

def step_card(m, sid, s, num, pad):
    p = " " * pad
    body = reindent(m.sub(s.get("body", "")), p + "      ")
    for h in m.notes.get(sid, []):
        body += "\n" + reindent(m.sub(h), p + "      ")
    st = m.status[sid]
    return (f'{p}<details class="step-card" id="step-{num.replace(".", "-")}" open>\n'
            f'{p}  <summary class="card-head">\n'
            f'{p}    <span class="card-title"><span class="card-num">Step {num}</span><h4>{m.sub(s["name"])}</h4></span>\n'
            f'{p}    {pill(st)}\n'
            f'{p}  </summary>\n'
            f'{p}  <div class="step-body">\n'
            f'{p}    <div class="prose">\n'
            f'{body}\n'
            f'{p}    </div>\n'
            f'{p}    <a class="back" href="#overview">↑ Back to overview</a>\n'
            f'{p}  </div>\n'
            f'{p}</details>')


def overview_rows(m, pid, short, num):
    steps = m.phase_steps(pid)
    trs = []
    for k, (sid, s) in enumerate(steps, 1):
        cell = (f'\n          <th class="phase" scope="rowgroup" rowspan="{len(steps)}" data-target="phase-{num}" tabindex="0">'
                f'<span class="ph"><span class="ph-num">{num}</span><span class="ph-name">{m.sub(short)}</span></span></th>'
                if k == 1 else "")
        n = m.num_of[sid]
        trs.append(f'        <tr data-target="step-{n.replace(".", "-")}" tabindex="0">{cell}\n'
                   f'          <td class="step" data-step="{n}"><span class="sn">{n}</span> {m.sub(s["name"])}</td>\n'
                   f'          <td class="st">{pill(m.status[sid])}</td>\n        </tr>')
    return f'      <tbody data-phase="{num}">\n' + "\n".join(trs) + "\n      </tbody>"


def build_content(m):
    meta = m.M
    rows, cards, feature_rows, feature_cards = [], [], [], []
    all_st = []
    for pid, ph in m.phases:
        num = m.pnum[pid]
        steps = m.phase_steps(pid)
        sts = [m.status[sid] for sid, _ in steps]
        all_st += sts
        rows.append(overview_rows(m, pid, ph["name"], num))
        intro = m.sub(ph.get("intro", ""))
        desc = f'      <p class="phase-desc">{intro}</p>\n' if intro else ""
        cards.append(f'''
  <details class="phase-card" id="phase-{num}" open>
    <summary class="card-head">
      <span class="card-title"><span class="card-num">Phase {num}</span><h3>{m.sub(ph["name"])}</h3></span>
      {pill(phase_status(sts))}
    </summary>
    <div class="phase-body">
{desc}''' + "\n".join(step_card(m, sid, s, m.num_of[sid], 6) for sid, s in steps) + "\n    </div>\n  </details>")
    for pid, ph in m.feats:
        num = m.pnum[pid]
        steps = m.phase_steps(pid)
        sts = [m.status[sid] for sid, _ in steps]
        all_st += sts
        feature_rows.append(overview_rows(m, pid, ph.get("short") or ph["name"], num))
        desc = f'\n        <p class="feature-desc">{m.sub(ph["desc"])}</p>' if ph.get("desc") is not None else ""
        feature_cards.append(
            f'    <details class="phase-card" id="phase-{num}" data-feature="{ph["feature"]}" open>\n'
            f'      <summary class="card-head">\n'
            f'        <span class="card-title"><span class="card-num">Feature {num}</span><h3>{m.sub(ph["name"])}</h3></span>\n'
            f'        {pill(phase_status(sts))}\n'
            f'      </summary>\n'
            f'      <div class="phase-body">{desc}\n'
            + "\n".join(step_card(m, sid, s, m.num_of[sid], 8) for sid, s in steps)
            + "\n      </div>\n    </details>")
    live = [x for x in all_st if x != "skipped"]
    progress = f"{sum(x == 'done' for x in live)} of {len(live)} done"
    if feature_rows:
        rows.append('      <tbody class="split"><tr><th scope="colgroup" colspan="3">Future Ideas</th></tr></tbody>')
        rows += feature_rows

    sections = "".join(f'<section class="block block-extra" id="{sec["id"]}">\n  <h2>{m.sub(sec["name"])}</h2>\n'
                       f'{reindent(m.sub(sec.get("body", "")), "  ")}\n</section>\n\n' for _, sec in m.sections)
    ideas = []
    for _, idea in m.ideas:
        dec = ' data-decision="reject"' if idea.get("decision") == "reject" else ""
        more = (f'\n      <div class="idea-more prose">\n{reindent(m.sub(idea["details"]), " " * 8)}\n      </div>'
                if idea.get("details") else "")
        ideas.append(f'''    <article class="idea-card" data-feature="{idea["feature"]}"{dec}>
      <div class="idea-text">
        <h3>{m.sub(idea["name"])}</h3>
        <p>{m.sub(idea.get("sentence", ""))}</p>
      </div>{more}
    </article>''')
    board = "\n".join(feature_cards + ideas) if feature_cards or ideas else "    <p>No future ideas yet.</p>"
    baked = f' data-baked="{m.stamp}"' if m.stamp else ""
    created = meta.get("created") or m.updated
    return f'''
<header class="plan-header">
  <div class="plan-top">
    <h1>{m.sub(meta["title"])}</h1>
    <dl class="meta"{baked}>
      <dt>Version</dt><dd>{m.version}</dd>
      <dt>Created</dt><dd><time datetime="{created}">{human(created)}</time></dd>
      <dt>Last updated</dt><dd><time datetime="{m.updated}">{human(m.updated)}</time></dd>
    </dl>
  </div>
  <p class="summary">{m.sub(meta.get("summary", ""))}</p>
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

''' + sections + '''<section class="block" id="details">
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


def plan_styles(m):
    styles = m.M.get("styles") or ""
    return [f"<style>\n/* plan-specific */\n{styles.strip()}\n</style>"] if styles.strip() else []


def snapshot(m, template):
    return wrap(build_content(m), text_of(m.sub(m.M["title"])), plan_styles(m), template)


def dropped(m):
    """Entry text the page's allowlist would leave out, as 'doc.field: what'."""
    out = []
    for k, v in sorted(m.E.items()):
        out += check_entry(k, v)
    return out + check_entry("_plan", {"title": m.M.get("title", ""), "summary": m.M.get("summary", "")})


# ---------------------------------------------------------------------------------------------- the fold
# A snapshot writes everything the records changed into the entries, then stamps _plan.bakedAt, after which the
# records are ignored and can go. The page can't write in one batch, so it goes: (1) one fold record, a checkpoint
# holding every changed entry, which shows the same plan at once; (2) the entries; (3) _plan, with bakedAt the fold
# record's time; (4) deleting the records. Stopped anywhere, the page still shows the same plan. plan.js's Save
# Snapshot does the same (foldPlan there).

def folded(m):
    """The entries and _plan as they'd be with every record written in."""
    F = copy.deepcopy(m.E)
    for pid, ph in m.feats:
        for k in [k for k, v in list(F.items()) if v.get("kind") == "idea" and v.get("feature") == ph["feature"]]:
            F.pop(k)
    for sid, st in m.status.items():
        if sid in F:
            F[sid]["status"] = st
    for sid, hs in m.notes.items():
        if sid in F:
            body = F[sid].get("body", "")
            for h in hs:
                if h not in body:
                    body = body + "\n" + h if body else h
            F[sid]["body"] = body
    meta = dict(m.M)
    meta.update({"version": m.version, "updated": m.updated, "bakedAt": m.stamp, "statusOrder": True})
    return F, meta


def fold_record(m, F, meta):
    """The fold record (a checkpoint with every changed entry); meta's bakedAt is set to its time."""
    entries = {k: v for k, v in F.items() if m.base.get(k) != v}
    entries.update({k: None for k in m.base if k not in F})
    r = {"steps": {}, "at": now_stamp(), "date": datetime.date.today().isoformat(), "fold": True,
         "checkpoint": {"entries": entries, "meta": {"title": meta.get("title", ""), "summary": meta.get("summary", "")},
                        "steps": {}, "notes": {}}}
    if len(json.dumps(r, ensure_ascii=False).encode("utf-8")) > 250_000:
        fail("the records changed more than one document holds (250 KB); fold in two goes")
    meta["bakedAt"] = r["at"]
    return r


def entry_writes(m, F):
    """[(op, doc id, body)] that bring the stored entries (seed and documents) to F."""
    out = []
    for k in sorted(F):
        v = F[k]
        if m.base.get(k) != v:
            out.append(("set", k, v))
    for k in sorted(m.base):
        if k not in F:
            if k in m.seeded:
                out.append(("set", k, {"deleted": True}))
            else:
                out.append(("delete", k, None))
    return out


# ---------------------------------------------------------------------------------------------- page -> entries

def convert(s):
    """A finished split page as plan entries (doc id -> body), _plan included. Statuses come from the overview rows.
    Returns (entries, warnings, references made into tokens)."""
    def inner_after(html, m, tag):
        return html[m.end():block_end(html, m.start(), tag) - len(f"</{tag}>")]
    out, used = {}, set()

    def new_id(prefix, name):
        base = f"{prefix}-{slug(name)}"
        i, d = 2, base
        while d in used:
            d, i = f"{base}-{i}", i + 1
        used.add(d)
        return d
    if "<!-- PLAN CONTENT START" not in s or not re.search(r"<dt>Version</dt><dd>[^<]*</dd>", s) or 'id="overview-table"' not in s:
        fail("this page isn't built from the better-plans template (no PLAN CONTENT markers, version list or overview "
             "table), so it can't be converted")
    title = re.search(r"<h1>(.*?)</h1>", s, re.S).group(1).strip()
    ver = re.search(r"<dt>Version</dt><dd>([^<]*)</dd>", s).group(1)
    meta_end = s.find("</dl>")
    dates = re.findall(r'<time datetime="([^"]*)">', s[:meta_end])
    baked = re.search(r'<dl class="meta" data-baked="([^"]*)"', s)
    summary = re.search(r'<p class="summary">([\s\S]*?)</p>', s).group(1).strip()
    styles = "\n".join(x.strip() for x in re.findall(r"<style>\s*/\* plan-specific \*/([\s\S]*?)</style>", s))
    out["_plan"] = {"kind": "plan", "title": title, "summary": summary, "version": ver, "created": dates[0],
                    "updated": dates[1], "bakedAt": baked.group(1) if baked else "", "styles": styles}
    warn = []
    row_status = dict(re.findall(r'<td class="step" data-step="([^"]+)">[\s\S]*?<td class="st"><span class="status" data-status="(\w+)"', s))
    shorts = dict(re.findall(r'data-target="phase-([^"]+)" tabindex="0"><span class="ph"><span class="ph-num">[^<]*</span><span class="ph-name">(.*?)</span>', s))
    for n, m in enumerate(re.finditer(r'<section class="block block-extra" id="([^"]+)">', s), 1):
        body = inner_after(s, m, "section")
        h = re.search(r"<h2>(.*?)</h2>", body, re.S)
        sid = new_id("x", m.group(1))
        out[sid] = {"kind": "section", "id": m.group(1), "name": h.group(1).strip(), "body": dedent(body[h.end():]),
                    "sort": n * GAP}

    def steps_of(card, pid):
        for k, sm in enumerate(re.finditer(r'<details class="step-card" id="step-([^"]+)"[^>]*>', card), 1):
            sc = card[sm.start():block_end(card, sm.start(), "details")]
            pm = re.search(r'<div class="prose">', sc)
            num = sm.group(1).replace("-", ".")
            name = re.search(r"<h4>(.*?)</h4>", sc, re.S).group(1).strip()
            st = row_status.get(num) or re.search(r'data-status="(\w+)"', sc).group(1)
            body = dedent(inner_after(sc, pm, "div"))
            # Anything between the details and the back link (a note, say) goes at the end of the details.
            after = sc[block_end(sc, pm.start(), "div"):]
            back = after.find('<a class="back"')
            extra = after[:back if back >= 0 else after.rfind("</div>")].strip()
            if extra:
                body += "\n" + dedent(extra)
                warn.append(f"step {num} had text after its details (outside .prose); it's now at the end of them")
            out[new_id("s", name)] = {"kind": "step", "phase": pid, "name": name, "body": body, "status": st,
                                      "sort": k * GAP}
    n = 0
    for m in re.finditer(r'<details class="phase-card" id="phase-(\d+)"[^>]*>', s):
        card = s[m.start():block_end(s, m.start(), "details")]
        name = re.search(r"<h3>(.*?)</h3>", card, re.S).group(1).strip()
        desc = re.search(r'<p class="phase-desc">([\s\S]*?)</p>', card)
        n += 1
        pid = new_id("p", name)
        out[pid] = {"kind": "phase", "name": name, "intro": desc.group(1).strip() if desc else "", "sort": n * GAP}
        steps_of(card, pid)
    board = re.search(r'<div class="feature-board" id="feature-board">', s)
    order = []
    if board:
        b0, b1 = board.end(), block_end(s, board.start(), "div")
        for m in re.compile(r'<(details|article)\b[^>]*>').finditer(s, b0, b1):
            if m.start() < (order[-1][1] if order else 0):
                continue
            end = block_end(s, m.start(), m.group(1))
            order.append((m, end))
    nf = ni = 0
    seen_idea = False
    for m, end in order:
        h = s[m.start():end]
        fid = re.search(r'data-feature="([^"]+)"', m.group(0)).group(1)
        if m.group(1) == "details":
            if seen_idea:
                warn.append(f"planned feature {fid} comes after an idea card on the board; it's shown before the ideas")
            nf += 1
            num = re.search(r'id="phase-([^"]+)"', m.group(0)).group(1)
            name = re.search(r"<h3>(.*?)</h3>", h, re.S).group(1).strip()
            desc = re.search(r'<p class="feature-desc">([\s\S]*?)</p>', h)
            pid = f"p-{fid}"
            used.add(pid)
            out[pid] = {"kind": "phase", "feature": fid, "name": name, "short": shorts.get(num, name),
                        "desc": desc.group(1).strip() if desc else None, "sort": nf * GAP}
            steps_of(h, pid)
        else:
            seen_idea = True
            ni += 1
            t = re.search(r'<div class="idea-text">\s*<h3>(.*?)</h3>\s*<p>([\s\S]*?)</p>', h)
            mm = re.search(r'<div class="idea-more prose">', h)
            iid = f"i-{fid}"
            used.add(iid)
            out[iid] = {"kind": "idea", "feature": fid, "name": t.group(1).strip(), "sentence": t.group(2).strip(),
                        "details": dedent(inner_after(h, mm, "div")) if mm else "", "sort": ni * GAP}
            if 'data-decision="reject"' in m.group(0):
                out[iid]["decision"] = "reject"
    # Step and feature numbers in the text become tokens, so they follow their step or feature when it moves.
    m = Model({"_plan": out["_plan"], **{k: v for k, v in out.items() if k != "_plan"}})
    refs = []
    for k, v in out.items():
        for f in TEXT_FIELDS:
            if isinstance(v.get(f), str):
                found = []
                v[f] = m.tokenize(v[f], found)
                refs += [f"{k}.{f}: {a} -> {m.sub(b)} ({b})" for a, b in found]
    return out, warn, refs


def seed_docs(entries):
    """_plan and the seed documents for a plan's entries: one seed while it fits well under the 256 KiB a document
    holds, else several."""
    docs = {"_plan": entries["_plan"]}
    rest = sorted((k, v) for k, v in entries.items() if k != "_plan")
    chunks, cur, size = [], {}, 0
    for k, v in rest:
        n = len(json.dumps(v, ensure_ascii=False).encode("utf-8")) + len(k) + 8
        if cur and size + n > SEED_LIMIT:
            chunks.append(cur)
            cur, size = {}, 0
        cur[k] = v
        size += n
    if cur or not chunks:
        chunks.append(cur)
    for i, c in enumerate(chunks):
        docs["_seed" if i == 0 else f"_seed{i + 1}"] = {"entries": c}
    return docs


# ---------------------------------------------------------------------------------------------- outline

def outline(m, show=(), jobs_only=False):
    meta = m.M
    all_st = [m.status[sid] for lst in m.steps.values() for sid, _ in lst if sid not in m.orphans]
    live = [x for x in all_st if x != "skipped"]
    nrec = len(m.records)
    out = [f"{text_of(m.sub(meta['title']))} | version {m.version} | created {meta.get('created')} | updated {m.updated} | "
           f"{sum(x == 'done' for x in live)} of {len(live)} done | {nrec} update record(s) since the last snapshot",
           "Summary: " + hp.one_line(m.sub(meta.get("summary", ""))) + "   [plan]"]
    shown = set(show)
    if jobs_only:   # a planned feature with changes for Claude: its steps' text too
        shown |= {m.pnum[pid] for pid, ph in m.feats
                  if isinstance(m.features.get(ph["feature"], {}).get("edit"), str) and m.features[ph["feature"]]["edit"].strip()}
    else:
        out.append("Sections: " + ", ".join(f"{text_of(m.sub(v['name']))} [section:{v['id']}]" for k, v in m.sections))

    def body_lines(text):
        return ["      | " + ln for ln in m.sub(text).split("\n")]
    for pid, ph in m.phases + m.feats:
        num = m.pnum[pid]
        sts = [m.status[sid] for sid, _ in m.phase_steps(pid)]
        kind = f"Feature {num}" if ph.get("feature") else f"Phase {num}"
        want = num in shown or f"phase:{num}" in shown or pid in shown
        if jobs_only and not want:
            if ph.get("feature"):
                out.append(f"{kind} {text_of(m.sub(ph['name']))} [{phase_status(sts)}] [{pid}]")
            continue
        out.append(f"{kind} {text_of(m.sub(ph['name']))} [{phase_status(sts)}] [{pid}]")
        if want:
            intro = ph.get("desc") if ph.get("feature") else ph.get("intro")
            if intro:
                out.append("    intro: " + hp.one_line(m.sub(intro)))
        for sid, s in m.phase_steps(pid):
            n = m.num_of[sid]
            extra = f" +{len(m.notes[sid])} note(s)" if m.notes.get(sid) else ""
            out.append(f"  {n} {text_of(m.sub(s['name']))} [{m.status[sid]}]{extra} [{sid}]")
            if n in shown or want or sid in shown:
                out += body_lines(s.get("body", ""))
                for h in m.notes.get(sid, []):
                    out += body_lines(h)
    for k, v in m.ideas:
        fid = v["feature"]
        ch = m.features.get(fid, {})
        dec = ch.get("decision") or v.get("decision") or "undecided"
        dec = {"keep": "accept", "remove": "reject"}.get(dec, dec)
        out.append(f"Idea {text_of(m.sub(v['name']))} [{dec}] [{k}]")
        job = dec == "accept" or (isinstance(ch.get("edit"), str) and ch["edit"].strip())
        if job or fid in shown or k in shown or f"idea:{fid}" in shown or f"idea:{k}" in shown:
            out.append("    sentence: " + hp.one_line(m.sub(v.get("sentence", ""))))
            if v.get("details"):
                out += body_lines(v["details"])
    for k, v in m.sections:
        if k in shown or v["id"] in shown or f"section:{v['id']}" in shown:
            out.append(f"Section {v['id']}:")
            out += body_lines(v.get("body", ""))
    if m.orphans:
        out.append("Steps whose phase is missing (not shown on the page): " + ", ".join(m.orphans))
    if m.misses:
        out.append("Changes in update records that changed nothing (redo them if they still matter):")
        out += ["  " + x for x in m.misses]
    jobs = idea_jobs(m)
    if jobs:
        out.append("Future ideas to bring in:")
        out += ["  " + j for j in jobs]
    if nrec > SNAPSHOT_HINT:
        out.append(f"{nrec} update records since the last snapshot, so nobody who can edit has opened the page since: "
                   "it saves a snapshot by itself the next time the user opens it.")
    return "\n".join(out)


def idea_jobs(m):
    jobs = []
    nxt = len(m.feats) + 1
    for k, v in m.ideas:
        ch = m.features.get(v["feature"], {})
        dec = {"keep": "accept", "remove": "reject"}.get(ch.get("decision"), ch.get("decision"))
        edit = ch.get("edit").strip() if isinstance(ch.get("edit"), str) else ""
        if dec == "accept":
            jobs.append(f"PLAN {v['feature']} as F{nxt}: {text_of(m.sub(v['name']))}"
                        + (f" (fold in its edit: {edit})" if edit else ""))
            nxt += 1
        elif edit:
            jobs.append(f"EDIT idea:{v['feature']}: {edit}")
    for pid, ph in m.feats:
        ch = m.features.get(ph["feature"], {})
        dec = {"keep": "accept", "remove": "reject"}.get(ch.get("decision"), ch.get("decision"))
        edit = ch.get("edit").strip() if isinstance(ch.get("edit"), str) else ""
        if dec in ("undecided", "reject"):
            started = [m.num_of[s] for s, _ in m.phase_steps(pid) if m.status[s] in ("progress", "done")]
            if started:
                jobs.append(f"ASK USER {ph['feature']} ({m.pnum[pid]}), now {dec}, but {', '.join(started)} started")
            else:
                jobs.append(f"TAKE OUT {ph['feature']} ({m.pnum[pid]}), now {dec}")
        if edit:
            jobs.append(f"EDIT {m.pnum[pid]} ({ph['feature']}): {edit}")
    return jobs


# ---------------------------------------------------------------------------------------------- build selections
# The phases the user ticked in the overview to build next, and the ones a session has claimed: one document,
# features/_build, {"phases": {<phase doc id>: {"state": "selected" | "claimed", "at", "by"}}}. The page writes ticks
# (null clears one); a session claims every ticked phase in one update pinned to the version it listed, so a second
# session (or a tick made in between) makes the write fail instead of both sessions building the same phase. plan.js's
# initBuild shows them, with the same rules for which phases can be ticked.

BUILD_DOC = "_build"
BATCH_BADGE = re.compile(r"<kbd>\s*Batch\b", re.I)
DEPENDS_ON = re.compile(r"<h5>\s*Depends\s+On\s*</h5>(.*?)(?=<h[1-5]\b|\Z)", re.I | re.S)


def build_entries(m):
    """features/_build's ticks and claims, {phase doc id: entry}."""
    phases = (m.features.get(BUILD_DOC) or {}).get("phases")
    if not isinstance(phases, dict):
        return {}
    return {pid: v for pid, v in phases.items() if isinstance(v, dict) and v.get("state") in ("selected", "claimed")}


def has_batches(m):
    return any(BATCH_BADGE.search(s.get("name", "")) for pid, _ in m.phases for _, s in m.phase_steps(pid))


def phase_state(m, pid):
    return phase_status([m.status[s] for s, _ in m.phase_steps(pid)])


def buildable(m, pid):
    """Whether the page shows a tick box for the phase: it has steps and isn't finished, and it's a planned feature
    that isn't waiting to be reset, or a core phase in a plan without batches."""
    ph = m.E.get(pid)
    if not ph or pid not in m.pnum or not m.phase_steps(pid) or phase_state(m, pid) in ("done", "skipped"):
        return False
    if ph.get("feature"):
        dec = (m.features.get(ph["feature"]) or {}).get("decision")
        return dec in (None, "accept", "keep")
    return not has_batches(m)


def phase_mentions(m, pid):
    """Other phases this phase's text mentions (its intro and its steps' details and notes), by doc id."""
    fpid = {ph["feature"]: k for k, ph in m.feats}
    texts = [m.E[pid].get("intro") or "", m.E[pid].get("desc") or ""]
    for sid, s in m.phase_steps(pid):
        texts += [s.get("body", "")] + m.notes.get(sid, [])
    out = []
    for kind, ref in TOKEN.findall("\n".join(texts)):
        other = m.E.get(ref, {}).get("phase") if kind == "S" else fpid.get(ref)
        if other and other != pid and other in m.pnum and other not in out:
            out.append(other)
    return out


def build_order(m, pids):
    """The phases in an order that puts each after the ones among them its text mentions, else in plan order."""
    rank = {pid: i for i, (pid, _) in enumerate(m.phases + m.feats)}
    need = {p: [o for o in phase_mentions(m, p) if o in pids] for p in pids}
    done, order = set(), []
    while len(order) < len(pids):
        ready = sorted((p for p in pids if p not in done and all(o in done for o in need[p])), key=rank.get)
        if not ready:   # they mention each other: plan order for the rest
            ready = sorted((p for p in pids if p not in done), key=rank.get)
        order.append(ready[0])
        done.add(ready[0])
    return order


def build_report(m):
    ent = build_entries(m)
    name = lambda pid: f"{m.pnum[pid]} {text_of(m.sub(m.E[pid]['name']))}"   # noqa: E731
    sel = [p for p, v in ent.items() if v["state"] == "selected" and buildable(m, p)]
    claimed = [p for p, v in ent.items() if v["state"] == "claimed" and p in m.pnum and phase_state(m, p) not in ("done", "skipped")]
    stale = [p for p in ent if p not in sel and p not in claimed]
    out = [f"Build selections in {text_of(m.sub(m.M['title']))}" + (" (core phases can't be ticked: the plan has batches)" if has_batches(m) else "")]
    if not sel:
        out.append("Nothing is ticked to build.")
    else:
        out.append(f"Ticked to build ({len(sel)}), in a suggested order (each after the ticked phases its text mentions):")
        for pid in build_order(m, sel):
            out.append(f"  {name(pid)} [{phase_state(m, pid)}] [{pid}]")
            out.append("    steps: " + ", ".join(f"{m.num_of[s]} {text_of(m.sub(v['name']))} [{m.status[s]}]" for s, v in m.phase_steps(pid)))
            for s, v in m.phase_steps(pid):
                dep = DEPENDS_ON.search(v.get("body", ""))
                if dep and m.status[s] not in ("done", "skipped"):
                    out.append(f"    {m.num_of[s]} depends on: " + hp.one_line(m.sub(dep.group(1))))
            ments = []
            for o in phase_mentions(m, pid):
                st = phase_state(m, o)
                if st in ("done", "skipped"):
                    continue
                how = "ticked" if o in sel else ("claimed" if o in claimed else "NOT ticked")
                ments.append(f"{name(o)} [{st}, {how}]")
            if ments:
                out.append("    mentions unfinished: " + "; ".join(ments))
    for pid in claimed:
        e = ent[pid]
        out.append(f"Claimed: {name(pid)} [{phase_state(m, pid)}] [{pid}]" + (f" by {e['by']}" if e.get("by") else "") + f" at {e.get('at', '?')}")
    if stale:
        out.append("Entries to clear (finished, gone, reset, or a core phase in a plan with batches): " + ", ".join(
            (name(p) if p in m.pnum else p) for p in stale))
    return "\n".join(out)


def build_claim(m, by, take=()):
    """The update that claims every ticked phase (and the phases in take, ticked or not, claimed or not), and clears
    entries that can't be built any more."""
    ent = build_entries(m)
    at = now_stamp()
    sel = [p for p, v in ent.items() if v["state"] == "selected" and buildable(m, p)]
    sel += [p for p in take if p not in sel]
    phases = {p: {"state": "claimed", "by": by, "at": at} for p in sel}
    for p, v in ent.items():
        if p not in sel and not (v["state"] == "claimed" and p in m.pnum and phase_state(m, p) not in ("done", "skipped")):
            phases[p] = {"__delete__": True}
    return build_order(m, sel), {"phases": phases}


def phase_brief(m, pid):
    """One phase's own text for a worker: its name, intro and every step still to do with its details. Finished
    steps are listed by name only."""
    ph = m.E[pid]
    kind = "Feature" if ph.get("feature") else "Phase"
    out = [f"# {kind} {m.pnum[pid]}: {text_of(m.sub(ph['name']))}"]
    intro = ph.get("desc") if ph.get("feature") else ph.get("intro")
    if intro:
        out += ["", hp.one_line(m.sub(intro))]
    for sid, s in m.phase_steps(pid):
        st = m.status[sid]
        out += ["", f"## Step {m.num_of[sid]}: {text_of(m.sub(s['name']))} [{LABELS[st]}]"]
        if st in ("done", "skipped"):
            continue
        out.append(m.sub(s.get("body", "")).strip())
        out += [m.sub(h).strip() for h in m.notes.get(sid, [])]
    return "\n".join(out) + "\n"


def build_release(m, pids):
    """The update that clears the given phases' entries, or with none every entry whose phase is finished or gone."""
    ent = build_entries(m)
    if not pids:
        pids = [p for p in ent if p not in m.pnum or phase_state(m, p) in ("done", "skipped")]
    return pids, {"phases": {p: {"__delete__": True} for p in pids}}


# ---------------------------------------------------------------------------------------------- writing records

def write_json(folder, name, body):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    (folder / f"{name}.json").write_text(json.dumps(body, ensure_ascii=False), encoding="utf-8")
    return folder / f"{name}.json"


def record(steps=None, notes=None, major=False, **ops):
    r = {"steps": steps or {}, "at": now_stamp(), "date": datetime.date.today().isoformat()}
    if r["steps"]:
        r["stay"] = True   # replay moves a phase whose status group changes only as far as it must (Model.settle)
    if notes:
        r["notes"] = notes
    for k, v in ops.items():
        if v:
            r[k] = v
    if major:
        r["major"] = True
    return r


def source_status(word, where):
    w = (word or "todo").strip().lower().replace(" ", "-")
    w = ALIASES.get(w, w)
    if w not in LABELS:
        fail(f"{where}: unknown status [{word}]: use one of {', '.join(LABELS)}")
    return w


def norm_body(lines):
    """Source lines as stored body HTML: plain text paragraphs wrapped, bare tables and svgs wrapped, at no indent."""
    return hp.body_html(lines, "")


SNIP_PHASE = re.compile(r"^phase(?:\s+\d+)?\s*:\s*(.+?)(?:\s*\{#([A-Za-z0-9_-]+)\})?$", re.I)
SNIP_FEATURE = re.compile(r"^feature(?:\s+F?\d+)?\s*:\s*(.+?)(?:\s*\{#([A-Za-z0-9-]+)\})?$", re.I)
SNIP_STEP = re.compile(r"^step(?:\s+F?\d+(?:\.\d+)?)?\s*:\s*(.+?)(?:\s*\[([^\]]*)\])?(?:\s*\{#([A-Za-z0-9_-]+)\})?(?:\s*\[([^\]]*)\])?$", re.I)


def parse_snippet(text):
    """A plan source fragment: ## Phase / ## Feature / ## Section / ## Idea parts and ### Step parts (steps before any
    phase or feature heading go where --phase / --after / --before say)."""
    parts, cur, in_pre = [], None, False
    loose = {"kind": "loose", "steps": []}
    for n, line in enumerate(text.splitlines(), 1):
        mk = None if in_pre else hp.MARKER.match(line)
        if mk:
            head = mk.group(2)
            ph, fe, st, sec, idea = (SNIP_PHASE.match(head), SNIP_FEATURE.match(head), SNIP_STEP.match(head),
                                     hp.SECTION.match(head), hp.IDEA.match(head))
            if st and len(mk.group(1)) == 3:
                owner = parts[-1] if parts and parts[-1]["kind"] in ("phase", "feature") else loose
                cur = {"kind": "step", "name": st.group(1), "status": source_status(st.group(2) or st.group(4), f"line {n}"),
                       "id": st.group(3), "line": n, "body": []}
                owner["steps"].append(cur)
            elif fe:
                name, short = (fe.group(1).split("|", 1) + [""])[:2]
                cur = {"kind": "feature", "name": name.strip(), "short": short.strip(), "id": fe.group(2), "line": n,
                       "body": [], "steps": []}
                parts.append(cur)
            elif ph:
                cur = {"kind": "phase", "name": ph.group(1), "id": ph.group(2), "line": n, "body": [], "steps": []}
                parts.append(cur)
            elif sec:
                cur = {"kind": "section", "name": sec.group(1), "id": sec.group(2), "line": n, "body": []}
                parts.append(cur)
            elif idea:
                cur = {"kind": "idea", "name": idea.group(1), "id": idea.group(2), "line": n, "body": []}
                parts.append(cur)
            else:
                fail(f"line {n}: {line.strip()!r} isn't a heading this command takes: use ## Phase: Name, "
                     "## Feature: Name | Short {#id}, ### Step: Name [status], ## Section: Name, ## Idea: Name")
            continue
        if cur is None:
            if line.strip():
                fail(f"line {n}: text before the first heading")
            continue
        cur["body"].append((n, line))
        opens, closes = len(re.findall(r"<pre\b", line, re.I)), len(re.findall(r"</pre>", line, re.I))
        in_pre = (in_pre or opens > closes) and not closes > opens
    if loose["steps"]:
        parts.insert(0, loose)
    if not parts:
        fail("the source has no parts")
    return parts


def strict(where, text, inline=False):
    bad = check_html(text, inline)
    if bad:
        fail(f"{where}: the page won't show " + "; ".join(bad[:5]) + ". Use the plan's own tags and classes "
             "(see Content in SKILL.md) and send it again")
    return text


def add_parts(text, to=None, after=None, before=None):
    """A plan source fragment as a record's add list. to / after / before place loose steps (a number or doc id)."""
    adds, major = [], False

    def step_parts(steps):
        out = []
        for s in steps:
            body = norm_body(s["body"])
            if not body.strip():
                fail(f"line {s['line']}: step {s['name']!r} has no details")
            out.append({"doc": f"s-{s['id'] or slug(s['name'])}", "name": strict(f"line {s['line']}", s["name"], True),
                        "body": strict(f"line {s['line']}", body), "status": s["status"]})
        return out
    for part in parse_snippet(text):
        k = part["kind"]
        if k == "loose":
            if not (to or after or before):
                fail("steps outside a ## Phase or ## Feature heading need --phase N (at its end), --after N.M or --before N.M")
            a = {"steps": step_parts(part["steps"])}
            if after:
                a["after"] = after
            elif before:
                a["before"] = before
            else:
                a["to"] = to
            adds.append(a)
            major = True
        elif k in ("phase", "feature"):
            if not part["steps"]:
                fail(f"line {part['line']}: {k} {part['name']!r} has no ### Step: parts")
            if k == "phase":
                p = {"doc": f"p-{part['id'] or slug(part['name'])}", "name": strict(f"line {part['line']}", part["name"], True),
                     "intro": strict(f"line {part['line']}", hp.inline_text(part["body"], "phase intro"), True)}
                a = {"phase": p, "steps": step_parts(part["steps"])}
                if after and re.fullmatch(r"\d+", str(after)):
                    a["after"] = str(after)
            else:
                fid = part["id"] or slug(part["name"])
                p = {"doc": f"p-{fid}", "feature": fid, "name": strict(f"line {part['line']}", part["name"], True),
                     "short": part["short"] or part["name"],
                     "desc": strict(f"line {part['line']}", hp.inline_text(part["body"], "feature description"), True)}
                a = {"feature": p, "steps": step_parts(part["steps"])}
            adds.append(a)
            major = True
        elif k == "section":
            hid = part["id"] or slug(part["name"])
            body = hp.section_html(part["body"], "")
            if not body.strip():
                fail(f"line {part['line']}: section {part['name']!r} is empty")
            adds.append({"section": {"doc": f"x-{hid}", "id": hid, "name": strict(f"line {part['line']}", part["name"], True),
                                     "body": strict(f"line {part['line']}", body)}})
            major = True
        elif k == "idea":
            fid = part["id"] or slug(part["name"])
            its = hp.items(part["body"])
            if not its or its[0][0] != "p":
                fail(f"line {part['line']}: idea {part['name']!r} needs its one or two sentences first, as a paragraph")
            sentence = hp.inline_text([(0, its[0][1])], "idea")
            details = "\n".join(hp.block_html(t, h, "") for t, h in its[1:])
            adds.append({"idea": {"doc": f"i-{fid}", "feature": fid, "name": strict(f"line {part['line']}", part["name"], True),
                                  "sentence": strict(f"line {part['line']}", sentence, True),
                                  "details": strict(f"line {part['line']}", details)}})
    return adds, major


def body_from_file(path, kind):
    lines = list(enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1))
    return hp.section_html(lines, "") if kind == "section" else norm_body(lines)


def rand4():
    return "".join(random.choice(string.ascii_lowercase) for _ in range(4))


# ---------------------------------------------------------------------------------------------- a new plan

def source_ids(entries, plan):
    """Phase and step doc ids from the source's {#id}s (convert names every entry after its name)."""
    def in_order(pred):
        return sorted((k for k, v in entries.items() if pred(v)), key=lambda k: entries[k]["sort"])
    ren = {}
    for pid, ph in zip(in_order(lambda v: v.get("kind") == "phase" and not v.get("feature")), plan["phases"]):
        if ph.get("id"):
            ren[pid] = f"p-{ph['id']}"
        for sid, st in zip(in_order(lambda v: v.get("kind") == "step" and v.get("phase") == pid), ph["steps"]):
            if st.get("id"):
                ren[sid] = f"s-{st['id']}"
    new = list(ren.values())
    for d in new:
        if new.count(d) > 1 or (d in entries and d not in ren):
            fail(f"the id {d[2:]!r} is used twice: give each phase and step its own {{#id}}, or leave it out")
    out = {}
    for k, v in entries.items():
        v = dict(v)
        if v.get("phase") in ren:
            v["phase"] = ren[v["phase"]]
        for f in TEXT_FIELDS:
            if isinstance(v.get(f), str):
                v[f] = TOKEN.sub(lambda m: "{{%s:%s}}" % (m.group(1), ren.get(m.group(2), m.group(2))), v[f])
        out[ren.get(k, k)] = v
    return out


def new_plan(src, template, today=None):
    """A plan source as entries (with _plan) and its first snapshot page. Same source format as htmlplan's new."""
    today = today or datetime.date.today()
    plan = hp.parse_source(Path(src).read_text(encoding="utf-8-sig"))
    page, counts = hp.build_page(plan, template, today, today, "1.0")
    entries, warn, refs = convert(page)
    entries = source_ids(entries, plan)
    entries["_plan"]["bakedAt"] = ""
    entries["_plan"]["snapshotAt"] = now_stamp()
    entries["_plan"]["statusOrder"] = True
    m = Model(seed_docs(entries))
    bad = dropped(m)
    if bad:
        fail("the page won't show " + "; ".join(bad[:5]) + ". Fix the source and send it again")
    return entries, snapshot(m, template), counts, warn
