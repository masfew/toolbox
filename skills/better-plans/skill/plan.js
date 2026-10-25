/* Fills in the progress count, makes each step card's status match the overview, sets each phase card's status
   from its steps, collapses every card not in progress, folds finished phases in the overview to one row each (and runs of them to one group row), makes
   overview rows (and phase cells) open and jump to their card,
   runs the future ideas' Accept, Reject and Reset buttons, idea details, drag-to-reorder and groups, and shows step statuses
   saved in the database since the page was last published.
   Database plans: when the plan's database holds its entries (the "plan" collection, with a "_plan" document), the page
   builds the whole plan from them and from the update records in "statuses" (buildModel and buildContent, the twins of
   dbplan.py's Model and build_content), and rebuilds whenever an entry or a record changes. The HTML in the page is only
   the last snapshot, shown until the database loads; the owner's Save Snapshot button writes a new one, and the page
   saves one by itself when the owner or an editor opens it and the last one is out of date.
   Published as plan.js beside every plan. */
(function () {
  var LABELS = { todo: 'Not started', progress: 'In progress', done: 'Done', blocked: 'Blocked', skipped: 'Skipped' };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var GAP = 1000;
  var TEXT_FIELDS = ['title', 'summary', 'name', 'short', 'intro', 'desc', 'sentence', 'details', 'body'];

  // ------------------------------------------------------------------------------------------------ database hub
  // One subscription per collection for the whole page load. Each run of boot() (the page's behaviour on the current
  // content) listens through the hub, so a rebuild doesn't resubscribe and the new content gets the last data at once.
  var hub = {
    db: null, canEdit: null, mode: null, dragging: false, saving: false, model: null, differs: false,
    plan: null, statuses: null, features: null, fl: [], sl: [], cl: [],
    live: { plan: false, statuses: false },   // the collection has arrived from the store, not only from the cache
    onFeatures: function (fn, err) { return listen(hub.fl, { fn: fn, err: err }, hub.features); },
    // Status records reach a run of boot() only for plans whose entries aren't in the database (mode "legacy").
    onStatuses: function (fn) { return listen(hub.sl, { fn: fn }, hub.mode === 'legacy' ? hub.statuses : null); },
    onCanEdit: function (fn) { return listen(hub.cl, { fn: fn }, hub.canEdit === null ? null : hub.canEdit); }
  };
  function listen(list, l, now) {
    list.push(l);
    if (now !== null && now !== undefined) l.fn(now);
    return function () { var i = list.indexOf(l); if (i > -1) list.splice(i, 1); };
  }
  function fire(list, value) { list.slice().forEach(function (l) { l.fn(value); }); }
  function docsOf(snap) { return snap.docs.map(function (d) { return { id: d.id, body: d.data() }; }); }

  var main = document.querySelector('main.page');
  if (!main) return;
  var lastBuilt = null, waiting = false;
  var foldChoice = {};   // overview phases the reader folded or unfolded ({folded, finished}), by phase name, kept through rebuilds
  var groupChoice = {};  // overview groups of finished phases the reader unfolded (core, future: true when folded), kept through rebuilds
  // The snapshot as parsed, before boot() changes anything, for the first comparison with what the entries build.
  var original = (function () {
    var m = markers(), holder = document.createElement('div');
    if (!m[0] || !m[1]) return '';
    for (var n = m[0].nextSibling; n && n !== m[1]; n = n.nextSibling) holder.appendChild(n.cloneNode(true));
    return holder.innerHTML.trim();
  })();
  var teardown = boot();
  startDatabase();

  function startDatabase() {
    if (!window.claude || !window.claude.use) return;
    window.claude.use('db').then(function (db) {
      if (!db) return null;
      hub.db = db;
      db.collection('features').onSnapshot(function (snap) {
        hub.features = docsOf(snap);
        fire(hub.fl, hub.features);
      }, function () {
        hub.db = null;
        hub.fl.slice().forEach(function (l) { if (l.err) l.err(); });
      });
      db.collection('statuses').onSnapshot(function (snap) {
        hub.statuses = docsOf(snap);
        hub.live.statuses = !(snap.metadata && snap.metadata.fromCache);
        if (hub.mode === 'legacy') fire(hub.sl, hub.statuses);
        refresh();
      }, function () { hub.statuses = hub.statuses || []; refresh(); });
      db.collection('plan').onSnapshot(function (snap) {
        hub.plan = docsOf(snap);
        hub.live.plan = !(snap.metadata && snap.metadata.fromCache);
        refresh();
      }, function () { hub.plan = hub.plan || []; refresh(); });
      return window.claude.use('user');
    }).then(function (user) {
      return user ? user.canEdit() : false;
    }).then(function (ok) {
      hub.canEdit = !!ok;
      fire(hub.cl, hub.canEdit);
      snapshotBar();
    }).catch(function () {});
  }

  // Decides the mode once both collections have arrived, and rebuilds the content when the entries or records change.
  function refresh() {
    if (hub.plan === null || hub.statuses === null || hub.saving) return;
    var meta = hub.plan.filter(function (d) { return d.id === '_plan'; })[0];
    if (!meta) {
      if (hub.mode !== 'legacy') { hub.mode = 'legacy'; fire(hub.sl, hub.statuses); }
      return;
    }
    hub.mode = 'db';
    // Never rebuild under the reader's hands: while a card is dragged or an edit box has the focus, wait.
    var active = document.activeElement;
    if (hub.dragging || (active && active.tagName === 'TEXTAREA' && main.contains(active))) {
      if (!waiting) {
        waiting = true;
        document.addEventListener('focusout', function again() {
          document.removeEventListener('focusout', again);
          setTimeout(function () { waiting = false; refresh(); }, 0);
        });
      }
      return;
    }
    var model;
    try { model = buildModel(hub.plan, hub.statuses); } catch (e) { if (window.console) console.warn('plan: entries not built', e); return; }
    hub.model = model;
    var frag = cleanPage(buildContent(model));
    var holder = document.createElement('div');
    holder.appendChild(frag.cloneNode(true));
    var html = holder.innerHTML.trim();   // the page's copy starts with one more line break
    hub.differs = html !== original;
    if (lastBuilt === null) lastBuilt = original;
    if (html !== lastBuilt) {
      lastBuilt = html;
      swap(frag, textOf(model.sub(model.M.title)));
    }
    snapshotBar();
  }

  // The nodes between the PLAN CONTENT comments.
  function markers() {
    var start = null, end = null;
    Array.prototype.forEach.call(main.childNodes, function (n) {
      if (n.nodeType !== 8) return;
      if (/^\s*PLAN CONTENT START/.test(n.data)) start = n;
      if (/^\s*PLAN CONTENT END/.test(n.data)) end = n;
    });
    return [start, end];
  }
  function swap(frag, title) {
    var m = markers();
    if (!m[0] || !m[1]) return;
    // What the reader opened or collapsed, and where they were. A card still as its status set it is left to the new
    // content's statuses: the snapshot may show a step in progress that the database has since marked done.
    var open = {}, ideasOpen = {}, y = window.scrollY;
    Array.prototype.forEach.call(main.querySelectorAll('details[id]'), function (d) { if (d.open !== d.autoOpen) open[d.id] = d.open; });
    Array.prototype.forEach.call(main.querySelectorAll('.idea-card.is-open[data-feature]'), function (c) { ideasOpen[c.getAttribute('data-feature')] = true; });
    teardown();
    while (m[0].nextSibling && m[0].nextSibling !== m[1]) main.removeChild(m[0].nextSibling);
    main.insertBefore(frag, m[1]);
    if (title) document.title = title;
    teardown = boot();
    Array.prototype.forEach.call(main.querySelectorAll('details[id]'), function (d) { if (d.id in open) d.open = open[d.id]; });
    Object.keys(ideasOpen).forEach(function (id) {
      var t = main.querySelector('.idea-card[data-feature="' + id + '"]:not([hidden]) > .idea-toggle');
      if (t) t.click();
    });
    window.scrollTo({ top: y, behavior: 'instant' });
  }

  // ------------------------------------------------------------------------------------------------ step and feature numbers in text
  // Mentions of a step (F7.2, 3.6) or a planned feature (F7) are stored as tokens ({{S:<step doc id>}}, {{F:<feature id>}}),
  // shown as its current number. Records may use plain numbers, made tokens here as the plan stood when the record was
  // written: the same rules as dbplan.py's tokenize_html, keep the two in step.
  var REFNUM = /(F?)([0-9]+)(?:\.([0-9]+))?/g;
  var SKIP_TAGS = { code: 1, pre: 1, svg: 1, kbd: 1, script: 1, style: 1 };
  var UNITS = /^\s*(?:%|×|x\b|k\b|h\b|s\b|ms\b|days?\b|weeks?\b|months?\b|years?\b|hours?\b|hrs?\b|minutes?\b|mins?\b|seconds?\b|secs?\b|times\b|px\b|pt\b|em\b|rem\b|fps\b|[kmg]?hz\b|[kmgt]i?b\b|tokens?\b|points?\b|pts\b|stars?\b|°)/i;
  var BEFORE = /(?:\b(?:versions?|ver|release|python|node|chrome|ios|android|windows|macos|opus|sonnet|haiku|claude|gpt|api|sdk|about|around|roughly|approximately|approx|nearly|almost|over|under|than|rated|scored?|rating|average|avg|median|mean|costs?|price)\.?|[~≈×$£€]|→|->|←|<-|=>)\s*$/i;
  var AFTER_ARROW = /^\s*(?:→|->|←|<-|=>)/;
  function refTokens(seg, idOf, fids) {
    var out = '', i = 0, m;
    REFNUM.lastIndex = 0;
    while ((m = REFNUM.exec(seg))) {
      var s = m.index, e = s + m[0].length, f = m[1], n = m[2], k = m[3];
      var prev = s ? seg.charAt(s - 1) : '', nxt = seg.charAt(e), nxt2 = seg.charAt(e + 1);
      var dotted = nxt === '.' && /[0-9]/.test(nxt2), rep = null;
      if (f) {
        if (!/[A-Za-z0-9_@{:]/.test(prev || ' ') && !/[A-Za-z0-9_]/.test(nxt || ' ') && !dotted) {
          if (k !== undefined && Object.prototype.hasOwnProperty.call(idOf, 'F' + n + '.' + k)) rep = '{{S:' + idOf['F' + n + '.' + k] + '}}';
          else if (Object.prototype.hasOwnProperty.call(fids, 'F' + n)) rep = '{{F:' + fids['F' + n] + '}}' + (k !== undefined ? '.' + k : '');
        }
      } else if (k !== undefined) {
        var num = n + '.' + k;
        if (Object.prototype.hasOwnProperty.call(idOf, num) && !/[A-Za-z0-9_.$#\/\\-]/.test(prev || ' ') && !/[A-Za-z0-9_%]/.test(nxt || ' ') && !dotted &&
            !UNITS.test(seg.slice(e, e + 16)) && !BEFORE.test(seg.slice(Math.max(0, s - 16), s)) && !AFTER_ARROW.test(seg.slice(e, e + 6))) {
          rep = '{{S:' + idOf[num] + '}}';
        }
      }
      if (rep) { out += seg.slice(i, s) + rep; i = e; }
    }
    return out + seg.slice(i);
  }
  function tokenizeHtml(text, idOf, fids) {
    if (!text) return text || '';
    var parts = text.split(/(<[^>]*>)/), depth = 0;
    for (var j = 0; j < parts.length; j++) {
      if (j % 2) {
        var t = /^<(\/?)([A-Za-z][A-Za-z0-9]*)/.exec(parts[j]);
        if (t && SKIP_TAGS[t[2].toLowerCase()]) {
          if (t[1]) depth = Math.max(0, depth - 1);
          else if (!/\/>$/.test(parts[j])) depth++;
        }
      } else if (!depth && parts[j]) parts[j] = refTokens(parts[j], idOf, fids);
    }
    return parts.join('');
  }

  // ------------------------------------------------------------------------------------------------ the model
  // The same rules as dbplan.py's Model: the entries (the seed documents' entries, each entry document over them), then
  // every record newer than _plan.bakedAt replayed in time order (see Model.replay there for what a record holds); numbers
  // from the sort keys; the version and Last updated.
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isObj(x) { return !!x && typeof x === 'object' && !Array.isArray(x); }
  function clone(x) { return JSON.parse(JSON.stringify(x)); }
  function byKey(a, b) {
    var x = a.body.sort || 0, y = b.body.sort || 0;
    return x < y ? -1 : x > y ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  }
  function phaseStatusOf(list) {
    if (!list.length) return 'todo';
    var live = list.filter(function (s) { return s !== 'skipped'; });
    if (!live.length) return 'skipped';
    if (live.every(function (s) { return s === 'done'; })) return 'done';
    if (live.indexOf('blocked') > -1) return 'blocked';
    if (live.indexOf('progress') > -1 || live.indexOf('done') > -1) return 'progress';
    return 'todo';
  }
  function overlay(planDocs) {
    var base = {}, own = {}, seeded = {}, docs = {};
    planDocs.forEach(function (d) { if (isObj(d.body)) docs[d.id] = d.body; });
    Object.keys(docs).filter(function (k) { return k.indexOf('_seed') === 0; }).sort().forEach(function (k) {
      var ent = isObj(docs[k].entries) ? docs[k].entries : {};
      Object.keys(ent).forEach(function (e) { if (isObj(ent[e])) { base[e] = ent[e]; seeded[e] = true; } });
    });
    Object.keys(docs).sort().forEach(function (k) {
      if (k.charAt(0) === '_') return;
      own[k] = true;
      if (docs[k].deleted) delete base[k]; else base[k] = docs[k];
    });
    return { base: base, own: own, seeded: seeded, meta: docs._plan };
  }
  // Numbers, from the order and the statuses. Phases go done, then in progress or blocked, then not started, then
  // skipped (core phases among themselves, planned features among themselves), in their stored order within each, so
  // a status change can renumber them. m.live is the replay's statuses; before it, the entries' own. Moves and adds
  // place things by the stored order (storedPhases, storedFeats). dbplan.py's number does the same. Only plans whose
  // _plan has statusOrder sort: older records name steps by the stored order's numbers, so a snapshot turns it on.
  var STATUS_RANK = { done: 0, progress: 1, blocked: 1, todo: 2, skipped: 3 };
  function number(m) {
    var items = Object.keys(m.E).map(function (k) { return { id: k, body: m.E[k] }; }).sort(byKey);
    m.storedPhases = []; m.storedFeats = []; m.sections = []; m.allIdeas = []; m.steps = {};
    items.forEach(function (d) {
      var k = d.body.kind;
      if (k === 'phase') (d.body.feature ? m.storedFeats : m.storedPhases).push(d);
      else if (k === 'section') m.sections.push(d);
      else if (k === 'idea') m.allIdeas.push(d);
      else if (k === 'step') (m.steps[d.body.phase] = m.steps[d.body.phase] || []).push(d);
    });
    function byStatus(list) {
      return list.map(function (ph, i) { return { ph: ph, r: rankOf(m, ph.id), i: i }; })
        .sort(function (a, b) { return a.r - b.r || a.i - b.i; }).map(function (x) { return x.ph; });
    }
    var sorted = !!m.M.statusOrder;
    m.phases = sorted ? byStatus(m.storedPhases) : m.storedPhases.slice();
    m.feats = sorted ? byStatus(m.storedFeats) : m.storedFeats.slice();
    var planned = {};
    m.feats.forEach(function (f) { planned[f.body.feature] = true; });
    m.ideas = m.allIdeas.filter(function (d) { return !has(planned, d.body.feature); });
    m.numOf = {}; m.idOf = {}; m.pnum = {}; m.fnum = {}; m.fids = {};
    m.phases.forEach(function (ph, p) {
      m.pnum[ph.id] = String(p + 1);
      (m.steps[ph.id] || []).forEach(function (s, i) { var n = (p + 1) + '.' + (i + 1); m.numOf[s.id] = n; m.idOf[n] = s.id; });
    });
    m.feats.forEach(function (ph, p) {
      var f = 'F' + (p + 1);
      m.pnum[ph.id] = f;
      m.fnum[ph.body.feature] = f;
      m.fids[f] = ph.body.feature;
      (m.steps[ph.id] || []).forEach(function (s, i) { var n = f + '.' + (i + 1); m.numOf[s.id] = n; m.idOf[n] = s.id; });
    });
  }
  function rankOf(m, pid) {
    return STATUS_RANK[phaseStatusOf((m.steps[pid] || []).map(function (s) {
      if (m.live && has(m.live, s.id)) return m.live[s.id];
      return LABELS[s.body.status] ? s.body.status : 'todo';
    }))];
  }
  // A phase whose status group a record (with stay) changed moves only as far as it must: up to the end of its new
  // group, or down to the top of it. Its sort key changes, so the stored order stays the order shown and later
  // moves, adds and status changes start from what the page showed. dbplan.py's settle does the same.
  function settle(m, shown, old) {
    var now = {};
    shown.forEach(function (ph) { now[ph.id] = rankOf(m, ph.id); });
    var up = shown.filter(function (ph) { return now[ph.id] < old[ph.id]; });
    var down = shown.filter(function (ph) { return now[ph.id] > old[ph.id]; }).reverse();
    up.concat(down).forEach(function (ph) {
      var keys = shown.filter(function (o) { return o.id !== ph.id && now[o.id] === now[ph.id]; })
        .map(function (o) { return o.body.sort || 0; });
      if (keys.length) ph.body.sort = now[ph.id] < old[ph.id] ? Math.max.apply(null, keys) + GAP : Math.min.apply(null, keys) - GAP;
    });
  }
  function bakedStatuses(m) {
    var out = {};
    Object.keys(m.steps).forEach(function (pid) {
      m.steps[pid].forEach(function (s) { out[s.id] = LABELS[s.body.status] ? s.body.status : 'todo'; });
    });
    return out;
  }
  function between(lo, hi) {
    if (lo === null && hi === null) return GAP;
    if (lo === null) return hi - GAP;
    if (hi === null) return lo + GAP;
    return (lo + hi) / 2;
  }
  function buildModel(planDocs, statusDocs) {
    var o = overlay(planDocs);
    if (!isObj(o.meta)) throw new Error('no _plan');
    var m = { base: o.base, own: o.own, seeded: o.seeded, E: clone(o.base), M: clone(o.meta) };
    m.sub = function (text) {
      return String(text || '').replace(/\{\{([FS]):([A-Za-z0-9_-]+)\}\}/g, function (_, t, id) {
        return t === 'F' ? (has(m.fnum, id) ? m.fnum[id] : 'F?') : (has(m.numOf, id) ? m.numOf[id] : '?');
      });
    };
    number(m);
    var bakedAt = m.M.bakedAt || '';
    var recs = (statusDocs || []).filter(function (r) {
      return r.id.charAt(0) !== '_' && isObj(r.body) && typeof r.body.at === 'string' && r.body.at > bakedAt;
    }).sort(function (a, b) {
      return a.body.at < b.body.at ? -1 : a.body.at > b.body.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    var lastCp = -1;
    recs.forEach(function (r, i) { if (isObj(r.body.checkpoint)) lastCp = i; });
    var status = bakedStatuses(m), notes = {};
    m.live = status;
    var v = /^(\d+)\.(\d+)$/.exec(String(m.M.version || '1.0'));
    var maj = v ? parseInt(v[1], 10) : 1, mnr = v ? parseInt(v[2], 10) : 0;
    var last = m.M.updated || '';
    recs.forEach(function (r, i) {
      var b = r.body, cp = b.checkpoint;
      if (i === lastCp && isObj(cp.entries)) {
        Object.keys(cp.entries).forEach(function (k) {
          if (cp.entries[k] === null) delete m.E[k];
          else if (isObj(cp.entries[k])) m.E[k] = clone(cp.entries[k]);
        });
        if (isObj(cp.meta)) ['title', 'summary'].forEach(function (f) { if (typeof cp.meta[f] === 'string') m.M[f] = cp.meta[f]; });
        number(m);
      }
      if (isObj(cp)) {
        status = bakedStatuses(m);
        m.live = status;
        Object.keys(isObj(cp.steps) ? cp.steps : {}).forEach(function (sid) { if (has(status, sid) && LABELS[cp.steps[sid]]) status[sid] = cp.steps[sid]; });
        number(m);
        notes = {};
        Object.keys(isObj(cp.notes) ? cp.notes : {}).forEach(function (sid) {
          if (Array.isArray(cp.notes[sid])) notes[sid] = cp.notes[sid].filter(function (h) { return typeof h === 'string'; });
        });
      }
      if (i >= lastCp) applyRecord(m, b, status, notes, i > lastCp);
      if (b.fold) return;
      if (b.major) { maj++; mnr = 0; } else mnr++;
      var day = typeof b.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(b.date) ? b.date : b.at.slice(0, 10);
      if (day > last) last = day;
    });
    var baked = bakedStatuses(m);
    m.status = {};
    Object.keys(baked).forEach(function (sid) { m.status[sid] = has(status, sid) ? status[sid] : baked[sid]; });
    m.notes = {};
    Object.keys(notes).forEach(function (sid) { if (has(m.status, sid) && notes[sid].length) m.notes[sid] = notes[sid]; });
    m.records = recs;
    m.version = maj + '.' + mnr;
    m.updated = last;
    m.stamp = recs.length ? recs[recs.length - 1].body.at : bakedAt;
    return m;
  }
  function resolve(m, ref) {
    var t = String(ref).trim();
    if (t === 'plan') return '_plan';
    if (has(m.E, t)) return t;
    if (has(m.idOf, t)) return m.idOf[t];
    var u = t.toUpperCase();
    if (u.indexOf('PHASE:') === 0) u = u.slice(6);
    var pids = Object.keys(m.pnum);
    for (var i = 0; i < pids.length; i++) if (m.pnum[pids[i]] === u) return pids[i];
    var low = t.toLowerCase();
    if (low.indexOf('idea:') === 0) {
      if (has(m.E, 'i-' + t.slice(5))) return 'i-' + t.slice(5);
      if (has(m.E, t.slice(5)) && m.E[t.slice(5)].kind === 'idea') return t.slice(5);   // the doc id the outline prints, [i-x]
    }
    if (low.indexOf('feature:') === 0) for (i = 0; i < m.feats.length; i++) if (m.feats[i].body.feature === t.slice(8)) return m.feats[i].id;
    if (low.indexOf('section:') === 0) for (i = 0; i < m.sections.length; i++) if (m.sections[i].body.id === t.slice(8) || m.sections[i].id === t.slice(8)) return m.sections[i].id;
    // A name, when exactly one phase, planned feature, step, section or idea has it.
    var named = Object.keys(m.E).sort().filter(function (k) {
      var v = m.E[k];
      return ['phase', 'step', 'section', 'idea'].indexOf(v.kind) > -1 && textOf(m.sub(v.name || '')).toLowerCase() === low;
    });
    return named.length === 1 ? named[0] : null;
  }
  function docOf(m, did) { return did === '_plan' ? m.M : (has(m.E, did) ? m.E[did] : null); }
  function mainField(m, did) {
    if (did === '_plan') return 'summary';
    var d = m.E[did];
    return { step: 'body', section: 'body', idea: 'details' }[d.kind] || (d.feature ? 'desc' : 'intro');
  }
  function applyRecord(m, r, status, notes, structural) {
    var idOf = Object.assign({}, m.idOf), fids = Object.assign({}, m.fids);
    function tok(text) { return typeof text === 'string' ? tokenizeHtml(text, idOf, fids) : ''; }
    function stepId(key) { return has(m.idOf, key) ? m.idOf[key] : (has(m.E, key) && m.E[key].kind === 'step' ? key : null); }
    var stIds = Object.keys(isObj(r.steps) ? r.steps : {}).map(function (k) { return [stepId(k), r.steps[k]]; });
    var noteIds = Object.keys(isObj(r.notes) ? r.notes : {}).map(function (k) { return [stepId(k), r.notes[k]]; });
    if (structural) {
      var changed = false, refs = {};
      var target = function (ref) { if (!has(refs, ref)) refs[ref] = resolve(m, ref); return refs[ref]; };
      var sets = Object.keys(isObj(r.set) ? r.set : {}).filter(function (t) { return isObj(r.set[t]); }).map(function (t) { return [target(t), r.set[t]]; });
      var renames = Object.keys(isObj(r.rename) ? r.rename : {}).filter(function (t) { return typeof r.rename[t] === 'string'; }).map(function (t) { return [target(t), r.rename[t]]; });
      var swaps = (Array.isArray(r.swaps) ? r.swaps : []).filter(isObj).map(function (s) { return [target(s['in'] || ''), s]; });
      var moves = (Array.isArray(r.moves) ? r.moves : []).filter(isObj).map(function (mv) {
        return [target(mv.what || ''), target(mv.before || mv.after || ''), !!mv.before];
      });
      var adds = (Array.isArray(r.add) ? r.add : []).filter(isObj);
      var addRefs = adds.map(function (a) {
        return [a.to ? target(a.to) : null, a.after ? target(a.after) : null, a.before ? target(a.before) : null];
      });
      sets.forEach(function (x) {
        var d = x[0] ? docOf(m, x[0]) : null;
        if (!d) return;
        Object.keys(x[1]).forEach(function (f) {
          if (TEXT_FIELDS.indexOf(f) > -1 && typeof x[1][f] === 'string' && ((f === 'title' || f === 'summary') === (x[0] === '_plan'))) d[f] = tok(x[1][f]);
        });
      });
      renames.forEach(function (x) {
        var d = x[0] ? docOf(m, x[0]) : null;
        if (!d) return;
        if (d.feature && d.kind === 'phase' && d.short === d.name) d.short = tok(x[1]);
        d[x[0] === '_plan' ? 'title' : 'name'] = tok(x[1]);
      });
      swaps.forEach(function (x) { if (x[0] && docOf(m, x[0])) swapText(m, x[0], x[1], tok); });
      Object.keys(isObj(r.takeout) ? r.takeout : {}).forEach(function (fid) {
        takeOut(m, fid, isObj(r.takeout[fid]) ? r.takeout[fid] : {}, tok);
        changed = true;
      });
      var fresh = [];
      adds.forEach(function (a, i) { addPart(m, a, addRefs[i][0], addRefs[i][1], addRefs[i][2], tok, status, fresh); changed = true; });
      moves.forEach(function (x) { if (movePart(m, x[0], x[1], x[2])) changed = true; });
      if (Array.isArray(r.order)) { reorder(m, r.order.filter(function (x) { return typeof x === 'string'; })); changed = true; }
      if (changed) number(m);
      if (fresh.length) {
        // The parts this record added may name themselves ("passed in F1.1"): a number the plan didn't
        // have before the record means what it is after it. Numbers it had keep their old meaning.
        var idNew = Object.assign({}, m.idOf, idOf), fidsNew = Object.assign({}, m.fids, fids);
        fresh.forEach(function (x) {
          Object.keys(x[1]).forEach(function (f) { m.E[x[0]][f] = typeof x[1][f] === 'string' ? tokenizeHtml(x[1][f], idNew, fidsNew) : ''; });
        });
      }
      Object.keys(status).forEach(function (sid) { if (!has(m.numOf, sid)) delete status[sid]; });
      Object.keys(m.steps).forEach(function (pid) {
        m.steps[pid].forEach(function (s) { if (!has(status, s.id)) status[s.id] = LABELS[s.body.status] ? s.body.status : 'todo'; });
      });
    }
    var shown = stIds.length && r.stay && m.M.statusOrder ? [m.phases.slice(), m.feats.slice()] : null, old = {};
    if (shown) shown[0].concat(shown[1]).forEach(function (ph) { old[ph.id] = rankOf(m, ph.id); });
    stIds.forEach(function (x) { if (x[0] && has(status, x[0]) && LABELS[x[1]]) status[x[0]] = x[1]; });
    noteIds.forEach(function (x) { if (x[0] && typeof x[1] === 'string') (notes[x[0]] = notes[x[0]] || []).push(tok(x[1])); });
    if (shown) shown.forEach(function (list) { settle(m, list, old); });
    if (stIds.length) number(m);   // the new statuses may move phases
  }
  function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function swapText(m, did, s, tok) {
    var d = docOf(m, did), f = mainField(m, did), old = s.old, nu = s['new'], under = s.under;
    if (typeof old !== 'string' || !old || typeof nu !== 'string') return false;
    var text = m.sub(d[f] || ''), a = 0, b = text.length;
    if (under) {
      var hm = new RegExp('<h([45])>\\s*' + escapeRe(under) + '\\s*</h\\1>', 'i').exec(text);
      if (!hm) return false;
      var end = hm.index + hm[0].length, rest = text.slice(end).search(new RegExp('<h[1-' + hm[1] + ']\\b'));
      a = end; b = rest < 0 ? text.length : end + rest;
    }
    if (text.slice(a, b).indexOf(old) > -1) {
      d[f] = tok(text.slice(0, a) + text.slice(a, b).split(old).join(nu) + text.slice(b));
      return true;
    }
    var nf = did === '_plan' ? 'title' : 'name', name = m.sub(d[nf] || '');
    if (!under && name.indexOf(old) > -1) { d[nf] = tok(name.split(old).join(nu)); return true; }
    return false;
  }
  function maxSort(m, test) {
    var best = null;
    Object.keys(m.E).forEach(function (k) { var v = m.E[k]; if (test(v)) { var s = v.sort || 0; if (best === null || s > best) best = s; } });
    return best === null ? 0 : best;
  }
  function takeOut(m, fid, part, tok) {
    var pid = null;
    Object.keys(m.E).forEach(function (k) { if (pid === null && m.E[k].kind === 'phase' && m.E[k].feature === fid) pid = k; });
    if (pid === null) return;
    var ph = m.E[pid];
    delete m.E[pid];
    Object.keys(m.E).forEach(function (k) { if (m.E[k].kind === 'step' && m.E[k].phase === pid) delete m.E[k]; });
    var iid = 'i-' + fid, details = typeof part.details === 'string' ? tok(part.details) : null;
    if (has(m.E, iid)) { if (details !== null) m.E[iid].details = details; }
    else {
      m.E[iid] = { kind: 'idea', feature: fid, name: ph.name || '', sentence: ph.desc || '', details: details || '',
        sort: maxSort(m, function (v) { return v.kind === 'idea'; }) + GAP };
    }
  }
  function freeId(m, doc, name) {
    var d = doc, n = 2;
    while (has(m.E, d)) {
      if (m.E[d].name === name) return null;
      d = doc + '-' + n; n++;
    }
    return d;
  }
  // fresh collects [doc id, {field: the record's text}] for each new entry, tokenized again once the record's numbers are known.
  function addPart(m, a, to, after, before, tok, status, fresh) {
    function putSteps(pid, steps, lo, hi) {
      steps = (steps || []).filter(function (s) { return isObj(s) && typeof s.doc === 'string'; });
      var n = steps.length;
      steps.forEach(function (s, j) {
        var name = tok(s.name || ''), sid = freeId(m, s.doc, name);
        if (!sid) return;
        var key = hi === null ? (lo || 0) + GAP * (j + 1) : lo === null ? hi - GAP * (n - j) : lo + (hi - lo) * (j + 1) / (n + 1);
        var st = LABELS[s.status] ? s.status : 'todo';
        m.E[sid] = { kind: 'step', phase: pid, name: name, body: tok(s.body || ''), status: st, sort: key };
        status[sid] = st;
        fresh.push([sid, { name: s.name || '', body: s.body || '' }]);
      });
    }
    function stepEnd(pid) {
      var best = null;
      Object.keys(m.E).forEach(function (k) { var v = m.E[k]; if (v.kind === 'step' && v.phase === pid && (best === null || (v.sort || 0) > best)) best = v.sort || 0; });
      return best;
    }
    var steps = a.steps || [], p, name, pid;
    if (isObj(a.phase) || isObj(a.feature)) {
      var feat = isObj(a.feature);
      p = feat ? a.feature : a.phase;
      if (typeof p.doc !== 'string') return;
      name = tok(p.name || '');
      pid = freeId(m, p.doc, name);
      if (pid === null) pid = p.doc;
      else if (feat) {
        m.E[pid] = { kind: 'phase', feature: p.feature || pid.slice(2), name: name, short: tok(p.short || p.name || ''), desc: tok(p.desc || ''),
          sort: maxSort(m, function (v) { return v.kind === 'phase' && v.feature; }) + GAP };
        fresh.push([pid, { name: p.name || '', short: p.short || p.name || '', desc: p.desc || '' }]);
      } else {
        var key, ps = m.storedPhases, ids = ps.map(function (x) { return x.id; });
        if (after && has(m.pnum, after) && !m.E[after].feature) {
          var i = ids.indexOf(after);
          key = between(ps[i].body.sort, i + 1 < ps.length ? ps[i + 1].body.sort : null);
        } else key = maxSort(m, function (v) { return v.kind === 'phase' && !v.feature; }) + GAP;
        m.E[pid] = { kind: 'phase', name: name, intro: tok(p.intro || ''), sort: key };
        fresh.push([pid, { name: p.name || '', intro: p.intro || '' }]);
      }
      putSteps(pid, steps, stepEnd(pid), null);
    } else if (isObj(a.section)) {
      p = a.section;
      var sid = typeof p.doc === 'string' ? freeId(m, p.doc, tok(p.name || '')) : null;
      if (sid) {
        m.E[sid] = { kind: 'section', id: p.id || sid.slice(2), name: tok(p.name || ''), body: tok(p.body || ''),
          sort: maxSort(m, function (v) { return v.kind === 'section'; }) + GAP };
        fresh.push([sid, { name: p.name || '', body: p.body || '' }]);
      }
    } else if (isObj(a.idea)) {
      p = a.idea;
      var iid = typeof p.doc === 'string' ? freeId(m, p.doc, tok(p.name || '')) : null;
      if (iid) {
        m.E[iid] = { kind: 'idea', feature: p.feature || iid.slice(2), name: tok(p.name || ''), sentence: tok(p.sentence || ''),
          details: tok(p.details || ''), sort: maxSort(m, function (v) { return v.kind === 'idea'; }) + GAP };
        fresh.push([iid, { name: p.name || '', sentence: p.sentence || '', details: p.details || '' }]);
      }
    } else {
      var ref = after || before;
      if (ref && has(m.E, ref) && m.E[ref].kind === 'step') {
        pid = m.E[ref].phase;
        var lst = m.steps[pid] || [], sids = lst.map(function (x) { return x.id; }), k = sids.indexOf(ref);
        if (k > -1) {
          if (after) putSteps(pid, steps, lst[k].body.sort, k + 1 < lst.length ? lst[k + 1].body.sort : null);
          else putSteps(pid, steps, k > 0 ? lst[k - 1].body.sort : null, lst[k].body.sort);
          return;
        }
      }
      if (to && has(m.E, to) && m.E[to].kind === 'phase') putSteps(to, steps, stepEnd(to), null);
    }
  }
  function movePart(m, what, ref, before) {
    if (!what || !ref || what === ref || !has(m.E, what) || !has(m.E, ref)) return false;
    var d = m.E[what], t = m.E[ref], lst, pid;
    if (d.kind !== t.kind || (d.kind !== 'step' && d.kind !== 'phase')) return false;
    if (d.kind === 'step') {
      pid = t.phase;
      lst = (m.steps[pid] || []).filter(function (x) { return x.id !== what; });
    } else {
      if (!!d.feature !== !!t.feature) return false;
      lst = (d.feature ? m.storedFeats : m.storedPhases).filter(function (x) { return x.id !== what; });
    }
    var ids = lst.map(function (x) { return x.id; }), i = ids.indexOf(ref);
    if (i < 0) return false;
    d.sort = before ? between(i > 0 ? lst[i - 1].body.sort : null, lst[i].body.sort)
      : between(lst[i].body.sort, i + 1 < lst.length ? lst[i + 1].body.sort : null);
    if (d.kind === 'step') d.phase = pid;
    number(m);
    return true;
  }
  function reorder(m, order) {
    var byf = {}, chosen = [];
    m.feats.forEach(function (ph) { byf[ph.body.feature] = ph.id; byf[ph.id] = ph.id; });
    order.forEach(function (x) { if (has(byf, x) && chosen.indexOf(byf[x]) < 0) chosen.push(byf[x]); });
    var keys = chosen.map(function (pid) { return m.E[pid].sort || 0; }).sort(function (a, b) { return a - b; });
    chosen.forEach(function (pid, i) { m.E[pid].sort = keys[i]; });
  }

  // ------------------------------------------------------------------------------------------------ the page builder
  // Builds the content between the PLAN CONTENT comments exactly as dbplan.py's build_content writes it. Entry text is
  // HTML; every piece goes through cleanFragment (the template's own tags and classes only) and the whole result through
  // cleanPage before it reaches the page, so nothing an entry holds runs or styles the page.
  function human(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? parseInt(p[2], 10) + ' ' + MONTHS[parseInt(p[1], 10) - 1] + ' ' + p[0] : '';
  }
  function attr(v) { return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'); }
  function pill(st) { return '<span class="status" data-status="' + st + '">' + LABELS[st] + '</span>'; }
  function spaces(n) { return new Array(n + 1).join(' '); }
  function reindent(chunk, pad) {
    if (!chunk) return '';
    var lines = chunk.split('\n');
    var lead = function (s) { return s.length - s.replace(/^\s+/, '').length; };
    var first = lead(lines[0]), out = [], inPre = false;
    lines.forEach(function (ln) {
      if (inPre) out.push(ln);
      else out.push(ln.trim() ? pad + ln.slice(Math.min(first, lead(ln))).replace(/\s+$/, '') : '');
      var opens = (ln.match(/<pre\b/gi) || []).length, closes = (ln.match(/<\/pre>/gi) || []).length;
      inPre = (inPre || opens > closes) && !(closes > opens);
    });
    return out.join('\n');
  }
  function block(m, text, pad) { return cleanFragment(reindent(m.sub(text), pad), false); }
  function inline(m, text) { return cleanFragment(m.sub(text), true); }

  function stepCard(m, s, pad) {
    var p = spaces(pad), num = m.numOf[s.id];
    var body = block(m, s.body.body, p + '      ');
    (m.notes[s.id] || []).forEach(function (h) { body += '\n' + block(m, h, p + '      '); });
    return p + '<details class="step-card" id="step-' + num.replace(/\./g, '-') + '" open>\n' +
      p + '  <summary class="card-head">\n' +
      p + '    <span class="card-title"><span class="card-num">Step ' + num + '</span><h4>' + inline(m, s.body.name) + '</h4></span>\n' +
      p + '    ' + pill(m.status[s.id]) + '\n' +
      p + '  </summary>\n' +
      p + '  <div class="step-body">\n' +
      p + '    <div class="prose">\n' +
      body + '\n' +
      p + '    </div>\n' +
      p + '    <a class="back" href="#overview">↑ Back to overview</a>\n' +
      p + '  </div>\n' +
      p + '</details>';
  }
  function overviewRows(m, ph, short, num) {
    var steps = m.steps[ph.id] || [];
    var trs = steps.map(function (s, k) {
      var cell = k ? '' : '\n          <th class="phase" scope="rowgroup" rowspan="' + steps.length + '" data-target="phase-' + num + '" tabindex="0">' +
        '<span class="ph"><span class="ph-num">' + num + '</span><span class="ph-name">' + inline(m, short) + '</span></span></th>';
      var n = m.numOf[s.id];
      return '        <tr data-target="step-' + n.replace(/\./g, '-') + '" tabindex="0">' + cell + '\n' +
        '          <td class="step" data-step="' + n + '"><span class="sn">' + n + '</span> ' + inline(m, s.body.name) + '</td>\n' +
        '          <td class="st">' + pill(m.status[s.id]) + '</td>\n        </tr>';
    });
    return '      <tbody data-phase="' + num + '">\n' + trs.join('\n') + '\n      </tbody>';
  }
  function buildContent(m) {
    var rows = [], cards = [], frows = [], fcards = [], all = [];
    function sts(ph) { return (m.steps[ph.id] || []).map(function (s) { return m.status[s.id]; }); }
    m.phases.forEach(function (ph) {
      var num = m.pnum[ph.id], list = sts(ph);
      all = all.concat(list);
      rows.push(overviewRows(m, ph, ph.body.name, num));
      var intro = inline(m, ph.body.intro || '');
      cards.push('\n  <details class="phase-card" id="phase-' + num + '" open>\n' +
        '    <summary class="card-head">\n' +
        '      <span class="card-title"><span class="card-num">Phase ' + num + '</span><h3>' + inline(m, ph.body.name) + '</h3></span>\n' +
        '      ' + pill(phaseStatusOf(list)) + '\n' +
        '    </summary>\n' +
        '    <div class="phase-body">\n' +
        (intro ? '      <p class="phase-desc">' + intro + '</p>\n' : '') +
        (m.steps[ph.id] || []).map(function (s) { return stepCard(m, s, 6); }).join('\n') + '\n    </div>\n  </details>');
    });
    m.feats.forEach(function (ph) {
      var num = m.pnum[ph.id], list = sts(ph), b = ph.body;
      all = all.concat(list);
      frows.push(overviewRows(m, ph, b.short || b.name, num));
      var desc = b.desc !== null && b.desc !== undefined ? '\n        <p class="feature-desc">' + inline(m, b.desc) + '</p>' : '';
      fcards.push('    <details class="phase-card" id="phase-' + num + '" data-feature="' + attr(b.feature) + '" open>\n' +
        '      <summary class="card-head">\n' +
        '        <span class="card-title"><span class="card-num">Feature ' + num + '</span><h3>' + inline(m, b.name) + '</h3></span>\n' +
        '        ' + pill(phaseStatusOf(list)) + '\n' +
        '      </summary>\n' +
        '      <div class="phase-body">' + desc + '\n' +
        (m.steps[ph.id] || []).map(function (s) { return stepCard(m, s, 8); }).join('\n') +
        '\n      </div>\n    </details>');
    });
    var live = all.filter(function (x) { return x !== 'skipped'; });
    var progress = live.filter(function (x) { return x === 'done'; }).length + ' of ' + live.length + ' done';
    if (frows.length) rows = rows.concat(['      <tbody class="split"><tr><th scope="colgroup" colspan="3">Future Ideas</th></tr></tbody>'], frows);
    var sections = m.sections.map(function (sec) {
      return '<section class="block block-extra" id="' + attr(sec.body.id) + '">\n  <h2>' + inline(m, sec.body.name) + '</h2>\n' +
        block(m, sec.body.body || '', '  ') + '\n</section>\n\n';
    }).join('');
    var ideas = m.ideas.map(function (d) {
      var b = d.body;
      var dec = b.decision === 'reject' ? ' data-decision="reject"' : '';
      var more = b.details ? '\n      <div class="idea-more prose">\n' + block(m, b.details, spaces(8)) + '\n      </div>' : '';
      return '    <article class="idea-card" data-feature="' + attr(b.feature) + '"' + dec + '>\n' +
        '      <div class="idea-text">\n' +
        '        <h3>' + inline(m, b.name) + '</h3>\n' +
        '        <p>' + inline(m, b.sentence || '') + '</p>\n' +
        '      </div>' + more + '\n    </article>';
    });
    var board = fcards.length || ideas.length ? fcards.concat(ideas).join('\n') : '    <p>No future ideas yet.</p>';
    var created = m.M.created || m.updated;
    return '\n<header class="plan-header">\n  <div class="plan-top">\n' +
      '    <h1>' + inline(m, m.M.title) + '</h1>\n' +
      '    <dl class="meta"' + (m.stamp ? ' data-baked="' + attr(m.stamp) + '"' : '') + '>\n' +
      '      <dt>Version</dt><dd>' + m.version + '</dd>\n' +
      '      <dt>Created</dt><dd><time datetime="' + attr(created) + '">' + human(created) + '</time></dd>\n' +
      '      <dt>Last updated</dt><dd><time datetime="' + attr(m.updated) + '">' + human(m.updated) + '</time></dd>\n' +
      '    </dl>\n  </div>\n' +
      '  <p class="summary">' + inline(m, m.M.summary || '') + '</p>\n</header>\n\n' +
      '<section class="block" id="overview">\n  <div class="block-head">\n    <h2>Plan Overview</h2>\n' +
      '    <span class="progress" data-progress>' + progress + '</span>\n  </div>\n  <div class="table-wrap">\n' +
      '    <table class="table overview" id="overview-table">\n' +
      '      <thead><tr><th scope="col">Phase</th><th scope="col">Step</th><th class="st" scope="col">Status</th></tr></thead>\n' +
      rows.join('\n') + '\n    </table>\n  </div>\n</section>\n\n' +
      sections + '<section class="block" id="details">\n  <h2>Build Outline</h2>\n' + cards.join('\n') + '\n</section>\n\n\n' +
      '<section class="block" id="future">\n  <h2>Future Ideas</h2>\n  <p class="block-intro" data-feature-hint hidden></p>\n' +
      '  <div class="feature-board" id="feature-board">\n' + board + '\n  </div>\n</section>\n\n';
  }

  // ------------------------------------------------------------------------------------------------ the allowlist
  // Only the template's own tags, classes and attributes survive. Content (entry text) gets the narrower set: no ids
  // except a diagram's arrowhead marker, and only the content classes (prose, notes, tables, diagrams).
  var INLINE_TAGS = 'a b br code em i kbd s small strong sub sup span'.split(' ');
  var CONTENT_TAGS = INLINE_TAGS.concat('p h4 h5 h6 ul ol li div table thead tbody tfoot tr th td pre blockquote hr dl dt dd svg g defs marker path rect circle ellipse line polyline polygon text tspan'.split(' '));
  var PAGE_TAGS = CONTENT_TAGS.concat('section header h1 h2 h3 details summary article time'.split(' '));
  var DROP = { script: 1, style: 1, iframe: 1, object: 1, embed: 1, template: 1, noscript: 1, foreignobject: 1, math: 1, link: 1, meta: 1, title: 1, form: 1, input: 1, button: 1, textarea: 1, select: 1, img: 1, video: 1, audio: 1, source: 1, use: 1, image: 1, animate: 1, set: 1, animatetransform: 1, animatemotion: 1 };
  var CONTENT_CLASSES = 'prose note note-label diagram table-wrap table d-box d-main d-edge d-head d-name d-sub d-main-sub'.split(' ');
  var PAGE_CLASSES = CONTENT_CLASSES.concat('plan-header plan-top meta summary block block-extra block-head progress overview phase ph ph-num ph-name step sn st status split phase-card step-card card-head card-title card-num phase-body step-body phase-desc feature-desc back block-intro feature-board idea-card idea-text idea-more'.split(' '));
  var ATTRS = { 'class': 1, href: 1, target: 1, rel: 1, viewbox: 1, role: 1, 'aria-label': 1, x: 1, y: 1, width: 1, height: 1, rx: 1, ry: 1, d: 1, cx: 1, cy: 1, r: 1, x1: 1, y1: 1, x2: 1, y2: 1, points: 1, 'text-anchor': 1, 'dominant-baseline': 1, 'marker-end': 1, 'marker-start': 1, 'marker-mid': 1, refx: 1, refy: 1, markerwidth: 1, markerheight: 1, orient: 1, transform: 1, colspan: 1, rowspan: 1, scope: 1 };
  var PAGE_ATTRS = { id: 1, open: 1, hidden: 1, tabindex: 1, datetime: 1, 'data-target': 1, 'data-step': 1, 'data-phase': 1, 'data-status': 1, 'data-progress': 1, 'data-feature-hint': 1, 'data-baked': 1, 'data-feature': 1, 'data-decision': 1 };
  function allowedValue(name, value) {
    if (name === 'href') return /^#[\w-]*$/.test(value) || /^https:\/\/[^\s"'<>]+$/.test(value);
    if (name === 'id') return /^[A-Za-z][\w-]*$/.test(value);
    if (name === 'target') return value === '_blank';
    if (name === 'rel') return /^(noopener|noreferrer|nofollow)( (noopener|noreferrer|nofollow))*$/.test(value);
    if (/^marker-/.test(name)) return /^url\(#[\w-]+\)$/.test(value);
    if (name === 'transform') return /^[\w\s.,()+-]*$/.test(value);
    if (name === 'd' || name === 'points' || name === 'viewbox') return /^[\w\s.,+-]*$/.test(value);
    return !/[<>]|javascript:|url\(|expression/i.test(value);
  }
  function cleanNode(src, out, mode) {
    Array.prototype.forEach.call(src.childNodes, function (n) {
      if (n.nodeType === 3) { out.appendChild(document.createTextNode(n.data)); return; }
      if (n.nodeType !== 1) return;
      var tag = n.localName.toLowerCase();
      if (DROP[tag]) return;
      var tags = mode === 'inline' ? INLINE_TAGS : mode === 'content' ? CONTENT_TAGS : PAGE_TAGS;
      if (tags.indexOf(tag) < 0) { cleanNode(n, out, mode); return; } // unknown: keep its text, drop the tag
      var el = document.createElementNS(n.namespaceURI || 'http://www.w3.org/1999/xhtml', n.localName);
      var classes = mode === 'page' ? PAGE_CLASSES : CONTENT_CLASSES;
      Array.prototype.forEach.call(n.attributes, function (a) {
        var name = a.name.toLowerCase(), value = a.value;
        if (!(ATTRS[name] || (mode === 'page' && PAGE_ATTRS[name]) || (name === 'id' && tag === 'marker'))) return;
        if (!allowedValue(name, value)) return;
        if (name === 'class') {
          value = value.split(/\s+/).filter(function (c) { return classes.indexOf(c) > -1; }).join(' ');
          if (!value) return;
        }
        el.setAttribute(a.name, value);
      });
      cleanNode(n, el, mode);
      out.appendChild(el);
    });
  }
  function parse(html) { var t = document.createElement('template'); t.innerHTML = html; return t.content; }
  // A piece of entry text, cleaned and written back as HTML for the builder to put in place.
  function cleanFragment(html, isInline) {
    var holder = document.createElement('div');
    cleanNode(parse(html), holder, isInline ? 'inline' : 'content');
    return holder.innerHTML;
  }
  // The whole content, cleaned once more as nodes: these, never the string, go into the page.
  function cleanPage(html) {
    var frag = document.createDocumentFragment();
    cleanNode(parse(html), frag, 'page');
    return frag;
  }
  function textOf(html) { return parse(html).textContent.trim(); }

  // ------------------------------------------------------------------------------------------------ the page's behaviour
  // boot() wires the page up on the content in place and returns a function that undoes it, so a rebuild can swap in
  // new content and boot again.
  function boot() {
    var offs = [], alive = true;
    function on(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      offs.push(function () { target.removeEventListener(type, fn, opts); });
    }
    var toTop = null, observer = null, glideFrame = 0;
    function teardownRun() {
      alive = false;
      offs.forEach(function (f) { f(); });
      if (glideFrame) cancelAnimationFrame(glideFrame);
      if (observer) observer.disconnect();
      if (toTop && toTop.parentNode) toTop.parentNode.removeChild(toTop);
    }
    var table = document.getElementById('overview-table');
    if (!table) return teardownRun;
    function tally(cells) {
      var done = 0, counted = 0;
      cells.forEach(function (cell) {
        var src = cell.parentNode.querySelector('.status');
        if (!src) return;
        var status = src.getAttribute('data-status');
        if (status !== 'skipped') counted++;
        if (status === 'done') done++;
      });
      return [done, counted];
    }
    var all = Array.prototype.slice.call(table.querySelectorAll('td.step[data-step]'));
    function cardPillOf(cell) { return document.querySelector('#step-' + cell.getAttribute('data-step').replace(/\./g, '-') + ' .status'); }
    all.forEach(function (cell) {
      var src = cell.parentNode.querySelector('.status');
      var dst = cardPillOf(cell);
      if (src && dst) { dst.setAttribute('data-status', src.getAttribute('data-status')); dst.textContent = src.textContent; }
    });
    var out = document.querySelector('[data-progress]');
    // Rows of a planned feature the user has reset are greyed out and left out of the count.
    function updateProgress() {
      var total = tally(all.filter(function (cell) { return !cell.closest('tbody').classList.contains('is-reset'); }));
      if (out) out.textContent = total[0] + ' of ' + total[1] + ' done';
    }
    updateProgress();

    // Build outline cards. A phase is done when every step that isn't skipped is done.
    function pillOf(card) { return card.querySelector(':scope > summary .status'); }
    function phaseStatus(list) {
      var counted = list.filter(function (s) { return s !== 'skipped'; });
      if (!counted.length) return 'skipped';
      if (counted.every(function (s) { return s === 'done'; })) return 'done';
      if (counted.indexOf('blocked') > -1) return 'blocked';
      if (counted.indexOf('progress') > -1 || counted.indexOf('done') > -1) return 'progress';
      return 'todo';
    }
    // On load every card is opened or collapsed by its status. Later (statuses arriving from the database) only the steps
    // in `changed` are, and the phases holding them, so cards the reader opened stay open. Each card remembers what it was
    // set to here (`autoOpen`), so a rebuild carries over only the cards the reader opened or collapsed, not this.
    function recountPhases(changed) {
      Array.prototype.forEach.call(document.querySelectorAll('.phase-card'), function (phase) {
        var list = [], anyOpen = false, touched = !changed;
        Array.prototype.forEach.call(phase.querySelectorAll('.step-card'), function (step) {
          var pill = pillOf(step);
          var s = pill ? pill.getAttribute('data-status') : 'todo';
          list.push(s);
          if (!changed || changed[step.id]) { step.open = s === 'progress'; step.autoOpen = step.open; touched = true; }
          if (step.open) anyOpen = true;
        });
        var st = phaseStatus(list);
        var pill = pillOf(phase);
        if (pill) { pill.setAttribute('data-status', st); pill.textContent = LABELS[st]; }
        if (touched) { phase.open = anyOpen; phase.autoOpen = anyOpen; }
      });
    }
    recountPhases(null);

    // Every phase (or planned feature) with steps folds up in the overview to one row (its phase cell, a step count and its
    // status) in place of a row per step. Finished ones (all done or skipped) start folded, the rest open. The chevron in its
    // phase cell, or a click on the rest of the folded row, unfolds it; the same chevron folds it again. What the reader chose
    // lasts through rebuilds (foldChoice) but not a reload, until the phase becomes finished or stops being finished: then it
    // folds or unfolds by its status again.
    function phaseKey(body) { var n = body.querySelector('th.phase .ph-name'); return n ? n.textContent : body.getAttribute('data-phase'); }
    Array.prototype.forEach.call(table.querySelectorAll('tbody[data-phase] th.phase .ph'), function (ph) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fold-btn';
      btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
      ph.parentNode.insertBefore(btn, ph);   // a strip down the cell's right edge (plan.css)
    });
    function setFold(body, folded, st, count) {
      var row = body.querySelector(':scope > tr.fold-row');
      body.classList.toggle('is-folded', folded);
      if (!folded) { if (row) body.removeChild(row); }
      else {
        if (!row) {
          row = document.createElement('tr');
          row.className = 'fold-row';
          var cell = body.querySelector('th.phase').cloneNode(true);
          cell.removeAttribute('rowspan');
          row.appendChild(cell);
          row.insertAdjacentHTML('beforeend', '<td class="fold-count"></td><td class="st"><span class="status"></span></td>');
          body.insertBefore(row, body.firstChild);
        }
        row.querySelector('.fold-count').textContent = count + (count === 1 ? ' step' : ' steps');
        var pill = row.querySelector('.status');
        pill.setAttribute('data-status', st);
        pill.textContent = LABELS[st];
      }
      Array.prototype.forEach.call(body.querySelectorAll('.fold-btn'), function (btn) {
        var label = folded ? 'Show steps' : 'Hide steps';
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.setAttribute('aria-expanded', String(!folded));
      });
    }
    function stepStatuses(body) {
      return Array.prototype.map.call(body.querySelectorAll('td.step[data-step]'), function (cell) {
        var pill = cell.parentNode.querySelector('.status');
        return pill ? pill.getAttribute('data-status') : 'todo';
      });
    }
    function isFinished(st) { return st === 'done' || st === 'skipped'; }
    function refold() {
      Array.prototype.forEach.call(table.querySelectorAll('tbody[data-phase]'), function (body) {
        var list = stepStatuses(body), st = phaseStatus(list), finished = isFinished(st);
        var key = phaseKey(body), choice = foldChoice[key];
        if (choice && choice.finished !== finished) { delete foldChoice[key]; choice = null; }
        body.classList.toggle('can-fold', list.length > 0);
        setFold(body, list.length > 0 && (choice ? choice.folded : finished), st, list.length);
      });
      regroup();
    }

    // Finished phases also fold together, into one group row: the core phases once every one is finished (GROUP_MIN_CORE or
    // more), and the done planned features at the top of Future Ideas once there are GROUP_MIN_FUTURE or more (the ones in
    // progress, not started or skipped stay out, below it). The group row shows the number range, a count and the status, and
    // starts folded; a click on it unfolds the group (each phase in it still folded by itself), and a row under the last one
    // folds it again. Unfolding the planned features glides down to the last finished ones and the next one or two after
    // them; folding glides back up to the group row when it's out of view.
    var GROUP_MIN_CORE = 2, GROUP_MIN_FUTURE = 10;
    var CHEVRON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg>';
    function regroup() {
      Array.prototype.forEach.call(table.querySelectorAll('tbody.group, tbody.group-end'), function (b) { b.parentNode.removeChild(b); });
      Array.prototype.forEach.call(table.querySelectorAll('tbody.in-group'), function (b) { b.classList.remove('in-group', 'group-hidden'); });
      var core = [], future = [], afterSplit = false, leading = true;
      Array.prototype.forEach.call(table.tBodies, function (body) {
        if (body.classList.contains('split')) { afterSplit = true; return; }
        if (!body.hasAttribute('data-phase')) return;
        var list = stepStatuses(body), st = phaseStatus(list);
        if (!afterSplit) core.push({ body: body, st: st, steps: list.length });
        else if (leading && st === 'done' && !body.classList.contains('is-reset')) future.push({ body: body, st: st, steps: list.length });
        else leading = false;
      });
      var coreDone = core.filter(function (x) { return x.st === 'done'; }).length;
      if (core.length >= GROUP_MIN_CORE && coreDone && core.every(function (x) { return isFinished(x.st); })) {
        var skipped = core.length - coreDone;
        makeGroup('core', core, 'Build Plan', 'All ' + core.length + ' phases ' + (skipped ? 'finished (' + skipped + ' skipped)' : 'done'));
      }
      if (future.length >= GROUP_MIN_FUTURE) makeGroup('future', future, 'Finished', future.length + ' planned features done');
    }
    function makeGroup(key, members, name, text) {
      var folded = key in groupChoice ? groupChoice[key] : true;
      var first = members[0].body.getAttribute('data-phase'), last = members[members.length - 1].body.getAttribute('data-phase');
      var steps = members.reduce(function (n, x) { return n + x.steps; }, 0);
      var head = document.createElement('tbody');
      head.className = 'group can-fold' + (folded ? ' is-folded' : '');
      head.setAttribute('data-group', key);
      head.innerHTML = '<tr class="fold-row group-row"><th class="phase" scope="row"><span class="ph"><span class="ph-num"></span>' +
        '<span class="ph-name"></span></span></th><td class="fold-count"></td><td class="st"><span class="status" data-status="done">' +
        LABELS.done + '</span></td></tr>';
      head.querySelector('.ph-num').textContent = first + '–' + last;
      head.querySelector('.ph-name').textContent = name;
      head.querySelector('.fold-count').textContent = text + ', ' + steps + (steps === 1 ? ' step' : ' steps');
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'fold-btn group-btn';
      btn.innerHTML = CHEVRON;
      var label = folded ? 'Show the ' + members.length + ' finished' : 'Hide the ' + members.length + ' finished';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      btn.setAttribute('aria-expanded', String(!folded));
      head.querySelector('th.phase').insertBefore(btn, head.querySelector('.ph'));
      table.insertBefore(head, members[0].body);
      members.forEach(function (x) { x.body.classList.add('in-group'); x.body.classList.toggle('group-hidden', folded); });
      if (folded) return;
      var end = document.createElement('tbody');
      end.className = 'group-end';
      end.setAttribute('data-group', key);
      end.innerHTML = '<tr><td colspan="3"><button type="button" class="group-hide">' + CHEVRON + '<span></span></button></td></tr>';
      end.querySelector('span').textContent = 'Hide the ' + members.length + ' finished ' + (key === 'core' ? 'phases' : 'features');
      table.insertBefore(end, members[members.length - 1].body.nextSibling);
    }
    function toggleGroup(key) {
      var keyboard = document.activeElement && document.activeElement.closest && document.activeElement.closest('tbody.group, tbody.group-end');
      var head = table.querySelector('tbody.group[data-group="' + key + '"]');
      var folded = !(head && head.classList.contains('is-folded'));
      // Read before the rows change: the browser's scroll anchoring may shift the page under rows that open above the view.
      var vh = window.innerHeight, y0 = window.scrollY;
      groupChoice[key] = folded;
      regroup();
      head = table.querySelector('tbody.group[data-group="' + key + '"]');
      if (!head) return;
      if (keyboard) head.querySelector('.group-btn').focus({ preventScroll: true });
      var y = window.scrollY;   // what the positions below are measured against
      if (folded) {
        var top = head.getBoundingClientRect().top;
        if (top < 0 || top > vh - 96) glideTo(top + y - vh / 4);
      } else if (key === 'future') {
        // Down to the bottom of the next one or two phases after the group, without pushing the group's end above 40% of the window.
        var end = table.querySelector('tbody.group-end[data-group="future"]'), next = [];
        for (var b = end.nextElementSibling; b && next.length < 2; b = b.nextElementSibling) if (b.hasAttribute('data-phase')) next.push(b);
        var bottom = (next.length ? next[next.length - 1] : end).getBoundingClientRect().bottom + y;
        var to = Math.min(bottom - vh + 24, end.getBoundingClientRect().top + y - vh * 0.4);
        if (to > y0) glideTo(to);
      }
    }
    function toggleFold(body) {
      var keyboard = document.activeElement && document.activeElement.classList.contains('fold-btn');
      var folded = !body.classList.contains('is-folded');
      foldChoice[phaseKey(body)] = { folded: folded, finished: isFinished(phaseStatus(stepStatuses(body))) };
      refold();
      // The chevron that was pressed may have gone with its row: keep the focus on the one now showing.
      if (keyboard) {
        var btn = body.querySelector(folded ? 'tr.fold-row .fold-btn' : 'tr[data-target] .fold-btn');
        if (btn) btn.focus();
      }
    }

    // Opening a card also opens the phase card around it.
    function reveal(target) {
      for (var el = target; el; el = el.parentElement) if (el.tagName === 'DETAILS') el.open = true;
    }
    function revealHash() {
      var target = location.hash && document.getElementById(location.hash.slice(1));
      if (target) reveal(target);
    }
    revealHash();
    on(window, 'hashchange', revealHash);

    // Future ideas. Accept, Reject and Reset choices are saved in the artifact's database, in the "features" collection
    // (one document per feature, keyed by its data-feature id: {decision: "accept" | "reject" | "undecided", edit: "..."}), where Claude
    // reads them back. Plans made before the rename saved "keep" and "remove", which still read as "accept" and "reject".
    // The edit is what the user typed in the card's edit box (its pencil): changes for Claude to make to that feature.
    // A planned feature (a phase card) whose saved decision is no longer "accept" shows as an idea card marked "Pending reset" until Claude
    // takes it out of the page, and its overview rows are greyed out.
    // Planned features in Pending show in F-number order. Dragging one by its handle (or moving it with the arrow keys) saves their new
    // order: on a database plan it moves the features' entries, so the page renumbers them at once; on an older plan it saves the
    // "_order" document of the features collection ({order: [data-feature ids]}) until Claude renumbers them to match.
    var board = document.getElementById('feature-board');
    var placeFeatures = null; // regroups the cards when step statuses change (see initStatuses)
    if (board) initFeatures(board);
    refold();   // after the features, which add their "Pending reset" label to the phase cell the fold row copies
    function initFeatures(board) {
      var DECISIONS = { accept: true, reject: true, undecided: true }, OLD_DECISIONS = { keep: 'accept', remove: 'reject' };
      function asDecision(d) { d = OLD_DECISIONS[d] || d; return DECISIONS[d] ? d : null; }
      var saved = {}, edits = {}, docs = {}, writes = {}, chains = {}, db = null, error = '';
      var savedOrder = null, confirmedOrder = null, orderSaving = false, orderQueued = null, drag = null;
      var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      function makeHandle() {
        var handle = document.createElement('button');
        handle.type = 'button';
        handle.className = 'drag-handle';
        handle.title = 'Drag to reorder';
        handle.setAttribute('aria-label', 'Reorder: drag, or press the up and down arrow keys');
        handle.innerHTML = '<svg viewBox="0 0 10 16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.5"/><circle cx="7.5" cy="3" r="1.5"/><circle cx="2.5" cy="8" r="1.5"/><circle cx="7.5" cy="8" r="1.5"/><circle cx="2.5" cy="13" r="1.5"/><circle cx="7.5" cy="13" r="1.5"/></svg>';
        return handle;
      }
      function makeButton(decide, label) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'idea-btn';
        btn.setAttribute('data-decide', decide);
        btn.textContent = label;
        return btn;
      }
      var EDIT_SAVED = 'Saved. Tell Claude you’ve updated your future ideas to make the change.';
      var ICONS = {
        accept: '<path d="M2.5 8.5 6.5 12.5 13.5 4"/>',
        reject: '<path d="M4 4l8 8M12 4l-8 8"/>',
        edit: '<path d="M10.5 2.5l3 3-8 8H2.5v-3z"/><path d="M8.5 4.5l3 3"/>'
      };
      function makeIcon(btn, icon, label) {
        btn.classList.add('icon-btn');
        btn.title = label;
        btn.setAttribute('aria-label', label);
        btn.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true">' + ICONS[icon] + '</svg>';
        return btn;
      }
      // The pencil opens an edit box along the bottom of the card. Each feature's boxes (a planned feature also has its reset idea card) share one edit.
      function addEdit(f, card, into, before) {
        var btn = makeIcon(document.createElement('button'), 'edit', 'Changes for Claude');
        btn.type = 'button';
        btn.className += ' idea-btn';
        btn.setAttribute('data-edit', '');
        var panel = document.createElement('div');
        panel.className = 'idea-edit';
        panel.id = 'edit-' + f.id + (card.classList.contains('phase-card') ? '-plan' : '');
        panel.hidden = true;
        var label = document.createElement('label');
        label.className = 'edit-label';
        label.htmlFor = panel.id + '-box';
        label.textContent = 'Changes for Claude';
        var box = document.createElement('textarea');
        box.id = panel.id + '-box';
        box.rows = 3;
        box.placeholder = 'What should change about this feature?';
        var status = document.createElement('p');
        status.className = 'edit-status';
        status.setAttribute('aria-live', 'polite');
        panel.appendChild(label);
        panel.appendChild(box);
        panel.appendChild(status);
        btn.setAttribute('aria-controls', panel.id);
        btn.setAttribute('aria-expanded', 'false');
        into.insertBefore(btn, before || null);
        (card.querySelector(':scope > .phase-body') || card).appendChild(panel);
        var e = { card: card, btn: btn, panel: panel, box: box, status: status };
        f.edits.push(e);
        box.addEventListener('input', function () {
          edits[f.id] = box.value;
          f.edits.forEach(function (o) { if (o !== e) o.box.value = box.value; });
          clearTimeout(f.timer);
          f.timer = setTimeout(function () { saveEdit(f); }, 800);
        });
        box.addEventListener('blur', function () { saveEdit(f); });
      }
      function addControls(f, card) {
        var text = card.querySelector('.idea-text') || card;
        var wait = document.createElement('p');
        wait.className = 'idea-wait';
        wait.textContent = 'Accepted · waiting to be planned';
        text.appendChild(wait);
        var actions = document.createElement('div');
        actions.className = 'idea-actions';
        actions.appendChild(makeIcon(makeButton('accept', ''), 'accept', 'Accept'));
        actions.appendChild(makeIcon(makeButton('reject', ''), 'reject', 'Reject'));
        var recover = makeButton('recover', 'Recover');
        recover.classList.add('recover-btn');
        recover.title = 'Bring this idea back to decide on it again';
        actions.appendChild(recover);
        card.appendChild(actions);
        var more = card.querySelector(':scope > .idea-more');
        if (more) addDetails(card, text, more);
        addEdit(f, card, actions);
      }
      // An idea's details stay hidden until the card's text or its chevron is clicked. Find in page still searches them and opens the card.
      function addDetails(card, text, more) {
        more.id = more.id || 'more-' + card.getAttribute('data-feature');
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'idea-toggle';
        toggle.setAttribute('aria-controls', more.id);
        card.appendChild(toggle);
        card.appendChild(more);
        card.classList.add('has-more');
        board.classList.add('has-details');
        function setOpen(open) {
          card.classList.toggle('is-open', open);
          more.hidden = open ? false : 'until-found';
          toggle.setAttribute('aria-expanded', String(open));
          toggle.setAttribute('aria-label', (open ? 'Hide' : 'Show') + ' details');
        }
        setOpen(false);
        toggle.addEventListener('click', function () { setOpen(!card.classList.contains('is-open')); });
        text.addEventListener('click', function (e) {
          if (e.target.closest('a, button') || String(window.getSelection())) return; // leave links and text selection alone
          setOpen(!card.classList.contains('is-open'));
        });
        more.addEventListener('beforematch', function () { setOpen(true); });
      }
      // One entry per feature. A planned feature also gets an idea card, built from its name and description, to show when it's reset.
      var features = Array.prototype.slice.call(board.querySelectorAll(':scope > [data-feature]')).map(function (card) {
        var f = { id: card.getAttribute('data-feature'), baked: asDecision(card.getAttribute('data-decision')) || 'undecided', idea: card, phase: null, rows: null, edits: [] };
        if (card.classList.contains('phase-card')) {
          f.baked = 'accept';
          f.phase = card;
          f.num = parseInt(card.id.replace(/^phase-F/, ''), 10) || 0;
          f.rows = table.querySelector('tbody[data-phase="' + card.id.replace(/^phase-/, '') + '"]');
          var phaseCell = f.rows && f.rows.querySelector('th.phase');
          if (phaseCell) {
            var phaseLabel = document.createElement('span');
            phaseLabel.className = 'ph-reset';
            phaseLabel.textContent = 'Pending reset';
            phaseCell.appendChild(phaseLabel);
          }
          var idea = document.createElement('article');
          idea.className = 'idea-card';
          idea.id = 'idea-' + card.id.replace(/^phase-/, '');
          idea.setAttribute('data-feature', f.id);
          idea.hidden = true;
          var text = document.createElement('div');
          text.className = 'idea-text';
          var name = document.createElement('h3');
          name.textContent = card.querySelector(':scope > summary h3').textContent;
          text.appendChild(name);
          var desc = card.querySelector('.feature-desc');
          if (desc) {
            var p = document.createElement('p');
            p.textContent = desc.textContent;
            text.appendChild(p);
          }
          var resetLabel = document.createElement('p');
          resetLabel.className = 'idea-reset';
          resetLabel.textContent = 'Pending reset · waiting to be cleared out';
          text.appendChild(resetLabel);
          idea.appendChild(text);
          board.appendChild(idea);
          f.idea = idea;
          var pill = pillOf(card);
          var reset = makeButton('reset', 'Reset');
          reset.classList.add('reset-btn');
          reset.title = 'Take this feature out of the plan and decide on it again';
          if (pill) pill.parentNode.insertBefore(reset, pill);
          var head = card.querySelector(':scope > summary');
          if (head) head.insertBefore(makeHandle(), head.firstChild);
          if (pill) {
            addEdit(f, card, pill.parentNode, pill);
            f.edits[0].btn.classList.add('edit-btn');
          }
        }
        addControls(f, f.idea);
        return f;
      });
      var groups = {};
      [['pending', 'Pending'], ['completed', 'Completed'], ['rejected', 'Rejected']].forEach(function (g) {
        var wrap = document.createElement('div');
        wrap.className = 'feature-group';
        wrap.setAttribute('data-group', g[0]);
        var title = document.createElement('div');
        title.className = 'group-title';
        var name = document.createElement('span');
        name.textContent = g[1];
        var count = document.createElement('span');
        count.className = 'group-count';
        title.appendChild(name);
        title.appendChild(count);
        var list = document.createElement('div');
        list.className = 'group-list';
        wrap.appendChild(title);
        wrap.appendChild(list);
        board.appendChild(wrap);
        groups[g[0]] = { wrap: wrap, list: list, count: count };
      });
      var hint = document.querySelector('[data-feature-hint]');
      function decisionOf(f) { return saved[f.id] || f.baked; }
      function joinParts(parts) { return parts.length < 2 ? parts.join('') : parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1]; }
      // Pending: planned features in the saved order (by F number where none is saved), then skipped planned features, then
      // accepted features waiting to be planned, then undecided ideas.
      function place() {
        if (drag) { drag.replace = true; return; }
        var focused = document.activeElement;
        var buckets = { pending: [], completed: [], rejected: [] }, toPlan = 0, toClear = 0, toEdit = 0;
        var pos = {};
        (savedOrder || []).forEach(function (id, n) { if (!(id in pos)) pos[id] = n; });
        features.forEach(function (f, i) {
          var d = decisionOf(f), planned = !!f.phase && d === 'accept', skipped = false, card, group, rank;
          var edit = edits[f.id] || '';
          if (edit.trim()) toEdit++;
          f.edits.forEach(function (e) {
            e.btn.classList.toggle('has-edit', !!edit.trim());
            if (e.box !== document.activeElement && e.box.value !== edit) {
              e.box.value = edit;
              e.status.textContent = edit.trim() ? EDIT_SAVED : '';
              e.status.classList.remove('feature-error');
            }
          });
          if (f.phase) {
            f.phase.hidden = !planned;
            f.idea.hidden = planned;
            if (f.rows) f.rows.classList.toggle('is-reset', !planned);
            if (!planned) toClear++;
          }
          if (planned) {
            card = f.phase;
            var pill = pillOf(card), st = pill ? pill.getAttribute('data-status') : 'todo';
            var reset = card.querySelector(':scope > summary .reset-btn');
            if (reset) reset.hidden = st !== 'todo';
            // Once a step is in progress or done (or every step is skipped), the feature is locked: no more changes for Claude.
            var locked = st === 'skipped' || Array.prototype.some.call(card.querySelectorAll('.step-card > summary .status'), function (s) {
              var v = s.getAttribute('data-status');
              return v === 'progress' || v === 'done';
            });
            f.edits.forEach(function (e) {
              if (e.card !== card) return;
              e.btn.hidden = locked;
              if (locked && !e.panel.hidden) {
                e.panel.hidden = true;
                e.btn.setAttribute('aria-expanded', 'false');
                setTimeout(function () { saveEdit(f); }, 0); // keeps anything typed before the lock
              }
            });
            // A skipped feature was approved and is only set aside, so it stays in Pending, below the planned features
            // still to do and above the ideas, and can't be dragged.
            skipped = st === 'skipped';
            card.classList.toggle('is-skipped', skipped);
            if (st === 'done') { group = 'completed'; rank = 0; }
            else { group = 'pending'; rank = skipped ? 1 : 0; }
          } else {
            card = f.idea;
            card.setAttribute('data-decision', d);
            Array.prototype.forEach.call(card.querySelectorAll('[data-decide]'), function (btn) {
              btn.setAttribute('aria-pressed', String(btn.getAttribute('data-decide') === d));
            });
            if (d === 'reject') { group = 'rejected'; rank = 1; }
            else { group = 'pending'; rank = d === 'accept' ? 2 : 3; }
            if (d === 'accept') toPlan++;
          }
          var sortable = group === 'pending' && planned && !skipped;
          buckets[group].push({ card: card, rank: rank, i: i, sortable: sortable, at: sortable && f.id in pos ? pos[f.id] : Infinity, num: f.num || 0 });
        });
        Object.keys(buckets).forEach(function (k) {
          // Infinity - Infinity is NaN, which falls through to the next key.
          buckets[k].sort(function (a, b) { return a.rank - b.rank || a.at - b.at || a.num - b.num || a.i - b.i; });
        });
        var planned = buckets.pending.filter(function (item) { return item.sortable; });
        var reordered = hub.mode !== 'db' && planned.some(function (item, n) { return n && item.num < planned[n - 1].num; });
        Object.keys(buckets).forEach(function (k) {
          // Only move cards when the order changed: moving one takes the caret out of an edit box being typed in.
          var list = groups[k].list, now = Array.prototype.filter.call(list.children, function (c) { return !c.hidden; });
          var same = now.length === buckets[k].length && buckets[k].every(function (item, n) { return now[n] === item.card; });
          if (!same) buckets[k].forEach(function (item) { list.appendChild(item.card); });
          groups[k].wrap.hidden = !buckets[k].length;
          groups[k].count.textContent = buckets[k].length;
        });
        groups.pending.wrap.classList.toggle('can-sort', planned.length > 1);
        updateProgress();
        if (hint) {
          var parts = [];
          if (toPlan) parts.push(toPlan + (toPlan === 1 ? ' accepted feature to plan' : ' accepted features to plan'));
          if (toClear) parts.push(toClear + (toClear === 1 ? ' reset feature to clear out' : ' reset features to clear out'));
          if (reordered) parts.push('a new order to apply');
          if (toEdit) parts.push(toEdit + (toEdit === 1 ? ' feature with changes to make' : ' features with changes to make'));
          hint.classList.toggle('feature-error', !!error);
          hint.textContent = error || 'Waiting on Claude: ' + joinParts(parts) + '. Tell Claude you’ve updated your future ideas to bring the plan up to date.';
          hint.hidden = !error && !parts.length;
        }
        if (focused && focused !== document.activeElement && document.body.contains(focused)) focused.focus();
      }
      place();
      placeFeatures = place;

      offs.push(hub.onFeatures(function (list) {
        db = hub.db;
        // A feature with a write of this page's still on its way keeps what this page set.
        var nextSaved = {}, nextEdits = {}, nextDocs = {};
        confirmedOrder = null;
        list.forEach(function (doc) {
          var body = doc.body;
          if (doc.id === '_order') {
            // On a database plan the order lives in the entries themselves; an old _order document is ignored.
            if (hub.mode !== 'db' && body && Array.isArray(body.order)) confirmedOrder = body.order.filter(function (id) { return typeof id === 'string'; });
          } else if (body) {
            nextDocs[doc.id] = body;
            if (asDecision(body.decision)) nextSaved[doc.id] = asDecision(body.decision);
            if (typeof body.edit === 'string') nextEdits[doc.id] = body.edit;
          }
        });
        Object.keys(writes).forEach(function (id) {
          if (!writes[id]) return;
          [[nextSaved, saved], [nextEdits, edits], [nextDocs, docs]].forEach(function (m) {
            if (id in m[1]) m[0][id] = m[1][id]; else delete m[0][id];
          });
        });
        saved = nextSaved;
        docs = nextDocs;
        features.forEach(function (f) {
          // Text typed but not yet sent stays in its box.
          if (f.timer && !writes[f.id]) nextEdits[f.id] = edits[f.id];
        });
        edits = nextEdits;
        if (!orderSaving && hub.mode !== 'db') savedOrder = confirmedOrder;
        place();
      }, function () { db = null; board.classList.remove('can-decide'); }));
      offs.push(hub.onCanEdit(function (ok) { if (ok && hub.db) board.classList.add('can-decide'); }));

      // Reordering. The card follows the pointer, swapping places with a neighbour once it passes the neighbour's middle,
      // and the new order is saved on release. Escape puts it back. Only the neighbours are moved in the page: moving the
      // dragged card itself would drop the pointer capture.
      // Only planned features (phase cards) in Pending that aren't skipped can move. They sit together at the top of the group.
      function sortableCards(list) { return Array.prototype.filter.call(list.children, function (c) { return !c.hidden && c.classList.contains('phase-card') && !c.classList.contains('is-skipped'); }); }
      function pendingOrder() {
        return sortableCards(groups.pending.list).map(function (c) { return c.getAttribute('data-feature'); });
      }
      function writeOrder(order) {
        if (orderSaving) { orderQueued = order; return; }
        orderSaving = true;
        var write = hub.mode === 'db' ? saveOrderRecord(order)
          : db.collection('features').doc('_order').set({ order: order, at: new Date().toISOString() });
        write.then(function () {
          confirmedOrder = order;
        }, function () {
          orderQueued = null;
          savedOrder = confirmedOrder;
          error = 'That order couldn’t be saved. Try again in a moment.';
          place();
        }).then(function () {
          orderSaving = false;
          if (orderQueued) { var next = orderQueued; orderQueued = null; writeOrder(next); }
        });
      }
      function saveOrder(order) {
        savedOrder = order;
        error = '';
        place();
        writeOrder(order);
      }
      function sameOrder(a, b) { return a.length === b.length && a.every(function (id, n) { return id === b[n]; }); }
      // Slides cards that changed place from where they were to where they are now.
      function slideFrom(tops) {
        if (reduceMotion) return;
        var moved = tops.filter(function (t) { return t[0].offsetTop !== t[1]; });
        moved.forEach(function (t) {
          t[0].style.transition = 'none';
          t[0].style.transform = 'translateY(' + (t[1] - t[0].offsetTop) + 'px)';
        });
        if (!moved.length) return;
        requestAnimationFrame(function () {
          moved.forEach(function (t) { t[0].style.transition = 'transform 0.15s ease'; t[0].style.transform = ''; });
        });
      }
      function follow() {
        var card = drag.card, list = drag.list;
        var want = drag.y - drag.grab - list.getBoundingClientRect().top;
        var others = sortableCards(list).filter(function (c) { return c !== card; });
        var tops = others.map(function (c) { return [c, c.offsetTop]; });
        for (var guard = 0; guard < 100; guard++) {
          var cards = sortableCards(list), n = cards.indexOf(card), prev = cards[n - 1], next = cards[n + 1];
          if (next && want + card.offsetHeight > next.offsetTop + next.offsetHeight / 2) list.insertBefore(next, card);
          else if (prev && want < prev.offsetTop + prev.offsetHeight / 2) list.insertBefore(prev, card.nextSibling);
          else break;
        }
        slideFrom(tops);
        card.style.transform = 'translateY(' + (want - card.offsetTop) + 'px)';
      }
      function autoScroll() {
        if (!drag || !alive) return;
        var edge = 48, step = 0;
        if (drag.y < edge) step = -Math.ceil((edge - drag.y) / 4);
        else if (drag.y > window.innerHeight - edge) step = Math.ceil((drag.y - window.innerHeight + edge) / 4);
        if (step) { window.scrollBy(0, step); follow(); }
        requestAnimationFrame(autoScroll);
      }
      function endDrag(keep) {
        var d = drag;
        drag = null;
        document.body.classList.remove('is-sorting');
        d.card.classList.remove('is-dragging');
        d.card.style.transition = reduceMotion ? 'none' : 'transform 0.15s ease';
        d.card.style.transform = '';
        var order = pendingOrder();
        if (keep && !sameOrder(order, d.before)) saveOrder(order);
        else place();
        hub.dragging = false;
        setTimeout(refresh, 0); // a rebuild that waited for the drag
      }
      board.addEventListener('pointerdown', function (e) {
        var handle = e.target.closest('.drag-handle');
        if (!handle || !db || drag || e.button !== 0) return;
        var card = handle.parentNode.parentNode;
        if (card.parentNode !== groups.pending.list || card.classList.contains('is-skipped')) return;
        e.preventDefault();
        try { handle.setPointerCapture(e.pointerId); } catch (err) {} // keeps the drag going when the pointer leaves the page
        drag = { card: card, list: card.parentNode, pointer: e.pointerId, y: e.clientY, grab: e.clientY - card.getBoundingClientRect().top, before: pendingOrder() };
        hub.dragging = true;
        card.style.transition = 'none';
        card.classList.add('is-dragging');
        document.body.classList.add('is-sorting');
        requestAnimationFrame(autoScroll);
      });
      on(window, 'pointermove', function (e) {
        if (!drag || e.pointerId !== drag.pointer) return;
        drag.y = e.clientY;
        follow();
      });
      on(window, 'pointerup', function (e) { if (drag && e.pointerId === drag.pointer) endDrag(true); });
      on(window, 'pointercancel', function (e) { if (drag && e.pointerId === drag.pointer) endDrag(false); });
      // Escape drops the drag, and place() puts the cards back in the saved order.
      on(document, 'keydown', function (e) { if (drag && e.key === 'Escape') endDrag(false); });
      // The arrow keys move a focused handle's card one place up or down.
      board.addEventListener('keydown', function (e) {
        var handle = e.target.closest && e.target.closest('.drag-handle');
        if (!handle || drag || !db || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
        e.preventDefault();
        var card = handle.parentNode.parentNode, list = card.parentNode;
        if (list !== groups.pending.list || card.classList.contains('is-skipped')) return;
        var cards = sortableCards(list), n = cards.indexOf(card);
        if (e.key === 'ArrowUp' && n > 0) list.insertBefore(card, cards[n - 1]);
        else if (e.key === 'ArrowDown' && n < cards.length - 1) list.insertBefore(cards[n + 1], card);
        else return;
        saveOrder(pendingOrder());
        handle.focus();
      });

      // Every write to a feature's document goes through here, one at a time, and carries the whole document,
      // so saving a choice keeps the edit and saving an edit keeps the choice.
      function writeFeature(id, patch) {
        docs[id] = Object.assign({}, docs[id], patch);
        writes[id] = (writes[id] || 0) + 1;
        var send = function () { return db.collection('features').doc(id).set(Object.assign({}, docs[id], { at: new Date().toISOString() })); };
        var run = (chains[id] || Promise.resolve()).then(send, send);
        chains[id] = run.then(done, done);
        function done() { writes[id]--; }
        return run;
      }
      function setStatus(f, text, failed) {
        f.edits.forEach(function (e) {
          e.status.textContent = text;
          e.status.classList.toggle('feature-error', !!failed);
        });
      }
      function saveEdit(f) {
        clearTimeout(f.timer);
        f.timer = 0;
        var text = edits[f.id] || '', before = (docs[f.id] && docs[f.id].edit) || '';
        if (!db || text === before) return;
        setStatus(f, 'Saving…');
        writeFeature(f.id, { edit: text }).then(function () {
          if ((edits[f.id] || '') === text) setStatus(f, text.trim() ? EDIT_SAVED : '');
          place();
        }, function () {
          if (docs[f.id]) docs[f.id].edit = before; // so the next try sends it again
          setStatus(f, 'That change couldn’t be saved. Try again in a moment.', true);
        });
        place();
      }
      function openEdit(f, e, open) {
        e.panel.hidden = !open;
        e.btn.setAttribute('aria-expanded', String(open));
        if (!open) { saveEdit(f); return; }
        if (e.card.tagName === 'DETAILS') e.card.open = true;
        if (!writes[f.id] && !f.timer) setStatus(f, (edits[f.id] || '').trim() ? EDIT_SAVED : '');
        e.box.focus();
      }

      board.addEventListener('click', function (e) {
        if (e.target.closest('.drag-handle')) { e.preventDefault(); return; } // a handle in a card header: don't collapse the card
        var pencil = e.target.closest('[data-edit]');
        var btn = e.target.closest('[data-decide]');
        if (!btn && !pencil) return;
        e.preventDefault(); // a Reset button or pencil sits in a card header: don't also collapse the card
        if (!db) return;
        var id = (btn || pencil).closest('[data-feature]').getAttribute('data-feature');
        var f = features.filter(function (x) { return x.id === id; })[0];
        if (!f) return;
        if (pencil) {
          var ed = f.edits.filter(function (x) { return x.btn === pencil; })[0];
          if (ed) openEdit(f, ed, ed.panel.hidden);
          return;
        }
        var pick = btn.getAttribute('data-decide');
        var next = pick === 'reset' || pick === 'recover' || decisionOf(f) === pick ? 'undecided' : pick;
        var had = Object.prototype.hasOwnProperty.call(saved, id), before = saved[id];
        saved[id] = next;
        error = '';
        place();
        if (pick === 'reset' || pick === 'recover') f.idea.querySelector('[data-decide="accept"]').focus();
        writeFeature(id, { decision: next }).catch(function () {
          if (had) saved[id] = before; else delete saved[id];
          if (docs[id]) { if (had) docs[id].decision = before; else delete docs[id].decision; }
          error = 'That choice couldn’t be saved. Try again in a moment.';
          place();
        });
      });
    }

    // Step statuses saved in the database, for a plan whose entries aren't in the database (on a database plan the
    // builder has already applied them). A status-only update doesn't republish the page: Claude adds one document to the
    // "statuses" collection ({steps: {"2.3": "done", ...}, at: ISO time, date: "YYYY-MM-DD"}), and the page shows the latest
    // status of each step over the one written in the HTML, then recounts everything that follows from statuses. Each record
    // adds 0.1 to the version shown, and the latest record's date is shown as Last updated. The next republish writes the
    // records into the HTML and stamps the newest one's time on the header's list (data-baked), so older records are ignored
    // until Claude deletes them. Documents whose id starts with "_" (the "_meta" marker) aren't records.
    initStatuses();
    function initStatuses() {
      var meta = document.querySelector('dl.meta');
      var bakedAt = (meta && meta.getAttribute('data-baked')) || '';
      var verCell = null, timeEl = null;
      if (meta) Array.prototype.forEach.call(meta.querySelectorAll('dt'), function (dt) {
        var dd = dt.nextElementSibling;
        if (!dd) return;
        if (dt.textContent.trim() === 'Version') verCell = dd;
        if (dt.textContent.trim() === 'Last updated') timeEl = dd.querySelector('time');
      });
      var baseVersion = verCell ? verCell.textContent : '';
      var baseDate = timeEl ? timeEl.getAttribute('datetime') || '' : '', baseDateText = timeEl ? timeEl.textContent : '';
      var baked = {};
      all.forEach(function (cell) {
        var src = cell.parentNode.querySelector('.status');
        if (src) baked[cell.getAttribute('data-step')] = src.getAttribute('data-status');
      });
      function longDate(iso) { var p = iso.split('-'); return parseInt(p[2], 10) + ' ' + MONTHS[parseInt(p[1], 10) - 1] + ' ' + p[0]; }
      function apply(docs) {
        var records = docs.filter(function (r) {
          return r.id.charAt(0) !== '_' && r.body && typeof r.body.at === 'string' && r.body.at > bakedAt &&
            r.body.steps && typeof r.body.steps === 'object';
        }).sort(function (a, b) {
          return a.body.at < b.body.at ? -1 : a.body.at > b.body.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        var want = Object.assign({}, baked), last = '';
        records.forEach(function (r) {
          Object.keys(r.body.steps).forEach(function (num) {
            var st = r.body.steps[num];
            if (num in want && LABELS[st]) want[num] = st;
          });
          var day = typeof r.body.date === 'string' && /^\d{4}-\d\d-\d\d$/.test(r.body.date) ? r.body.date : r.body.at.slice(0, 10);
          if (day > last) last = day;
        });
        var changed = null;
        all.forEach(function (cell) {
          var num = cell.getAttribute('data-step'), src = cell.parentNode.querySelector('.status');
          if (!src || src.getAttribute('data-status') === want[num]) return;
          [src, cardPillOf(cell)].forEach(function (pill) {
            if (pill) { pill.setAttribute('data-status', want[num]); pill.textContent = LABELS[want[num]]; }
          });
          (changed = changed || {})['step-' + num.replace(/\./g, '-')] = true;
        });
        if (changed) {
          recountPhases(changed);
          refold();
          updateProgress();
          if (placeFeatures) placeFeatures();
          revealHash();
        }
        var m = /^(\d+)\.(\d+)$/.exec(baseVersion);
        var version = m && records.length ? m[1] + '.' + (parseInt(m[2], 10) + records.length) : baseVersion;
        if (verCell && verCell.textContent !== version) verCell.textContent = version;
        if (timeEl) {
          var day = last > baseDate ? last : baseDate, text = day === baseDate ? baseDateText : longDate(day);
          if (timeEl.getAttribute('datetime') !== day) timeEl.setAttribute('datetime', day);
          if (timeEl.textContent !== text) timeEl.textContent = text;
        }
      }
      offs.push(hub.onStatuses(apply));
    }

    // Jumps glide there faster than the browser's own smooth scroll, easing out as they arrive, and stop the card a tenth of the
    // way down the window (its scroll-margin-top). Scrolling, a key or a click during the glide stops it where it is.
    var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    function stopGlide() { if (glideFrame) { cancelAnimationFrame(glideFrame); glideFrame = 0; } }
    ['wheel', 'touchstart', 'keydown', 'mousedown'].forEach(function (type) {
      on(window, type, stopGlide, { passive: true, capture: true });
    });
    function glide(target, id) {
      stopGlide();
      var from = window.scrollY;
      // Setting the hash marks the card (its flash) and starts the browser's own scroll, which the glide takes over from.
      if (location.hash !== '#' + id) { location.hash = id; window.scrollTo({ top: from, behavior: 'instant' }); }
      var margin = parseFloat(getComputedStyle(target).scrollMarginTop) || 0;
      glideTo(target.getBoundingClientRect().top + from - margin);
    }
    function glideTo(to) {
      stopGlide();
      var from = window.scrollY;
      var max = document.documentElement.scrollHeight - window.innerHeight;
      to = Math.max(0, Math.min(max, to));
      var dist = to - from;
      if (still || Math.abs(dist) < 2) { window.scrollTo({ top: to, behavior: 'instant' }); return; }
      var time = Math.min(450, 200 + Math.abs(dist) / 10);
      var start = performance.now();
      glideFrame = requestAnimationFrame(function frame(now) {
        var t = Math.min(1, (now - start) / time);
        window.scrollTo({ top: from + dist * (1 - Math.pow(1 - t, 3)), behavior: 'instant' });
        glideFrame = t < 1 && alive ? requestAnimationFrame(frame) : 0;
      });
    }
    // Links within the page (Back to overview) glide the same way.
    on(document, 'click', function (e) {
      var a = e.target.closest && e.target.closest('a[href^="#"]');
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      var id = decodeURIComponent(a.getAttribute('href').slice(1));
      var target = id && document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      reveal(target);
      glide(target, id);
    });

    function go(el) {
      var id = el.getAttribute('data-target');
      var target = document.getElementById(id);
      if (!target) return;
      // A reset feature's card is hidden: go to the idea card shown in its place.
      var resetCard = target.closest('.phase-card[hidden]');
      if (resetCard && document.getElementById('idea-' + resetCard.id.replace(/^phase-/, ''))) {
        id = 'idea-' + resetCard.id.replace(/^phase-/, '');
        target = document.getElementById(id);
      }
      reveal(target);
      glide(target, id);
    }
    table.addEventListener('click', function (e) {
      var group = e.target.closest('tbody.group, tbody.group-end');
      if (group && table.contains(group)) {
        if (group.classList.contains('group') || e.target.closest('.group-hide')) toggleGroup(group.getAttribute('data-group'));
        return;
      }
      var fold = e.target.closest('.fold-btn, tr.fold-row > td');
      if (fold && table.contains(fold)) { toggleFold(fold.closest('tbody')); return; }
      var el = e.target.closest('[data-target]');
      if (el && table.contains(el)) go(el);
    });
    table.addEventListener('keydown', function (e) {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.hasAttribute && e.target.hasAttribute('data-target')) {
        e.preventDefault();
        go(e.target);
      }
    });

    // Back to what's next: once the plan overview has scrolled out of view, a button in the bottom-right corner glides back up
    // to the overview's first row that isn't done or skipped (core steps first, then planned features; reset features left
    // out), with that row a third of the way down the window so the finished rows just above it show too. With every row
    // finished it glides to the top. Statuses are read at the click, so they follow records that arrived since load.
    var overview = document.getElementById('overview');
    function nextRow() {
      var rows = table.querySelectorAll('tbody:not(.split):not(.is-reset) tr[data-target]');
      for (var i = 0; i < rows.length; i++) {
        var pill = rows[i].querySelector('.status');
        var s = pill ? pill.getAttribute('data-status') : 'todo';
        if (s !== 'done' && s !== 'skipped') return rows[i];
      }
      return null;
    }
    function labelToTop() {
      var label = nextRow() ? 'Back to next step' : 'Back to top';
      toTop.title = label;
      toTop.setAttribute('aria-label', label);
    }
    if (overview && 'IntersectionObserver' in window) {
      toTop = document.createElement('button');
      toTop.type = 'button';
      toTop.className = 'to-top';
      document.body.appendChild(toTop);
      labelToTop();
      observer = new IntersectionObserver(function (entries) {
        var e = entries[entries.length - 1];
        var shown = !e.isIntersecting && e.boundingClientRect.bottom < 0;
        if (shown) labelToTop();
        toTop.classList.toggle('is-shown', shown);
      });
      observer.observe(overview);
      toTop.addEventListener('click', function (e) {
        var row = nextRow();
        glideTo(row ? row.getBoundingClientRect().top + window.scrollY - window.innerHeight / 3 : 0);
        // From the keyboard, focus moves to that row (or the title), since the button hides once the overview is back in view.
        if (!e.detail) {
          var el = row || document.querySelector('h1');
          if (el) { if (!row) el.tabIndex = -1; el.focus({ preventScroll: true }); }
        }
      });
    }
    return teardownRun;
  }

  // ------------------------------------------------------------------------------------------------ reordering, saved
  // A drag on a database plan saves one record holding the planned features' new order; the page replays it at once, so
  // they're renumbered straight away. Only the owner and editors can write, as the rules say.
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  function recordId(word) { return 'r-' + today().replace(/-/g, '') + '-' + word + '-' + Math.random().toString(36).slice(2, 6); }
  function saveOrderRecord(order) {
    if (!hub.db) return Promise.reject(new Error('no database'));
    return hub.db.collection('statuses').doc(recordId('order')).set({ steps: {}, at: new Date().toISOString(), date: today(), major: true, order: order });
  }

  // ------------------------------------------------------------------------------------------------ Save Snapshot
  // The owner's and editors' button on a database plan. It writes everything the records changed into the entries and
  // republishes the page with the plan as it is now, so the page's own HTML (what signed-out viewers and tools that don't
  // run scripts see, and what the version history keeps) is current. The same steps as dbplan.py's fold: one fold record
  // (a checkpoint holding every changed entry), the entries, _plan with bakedAt the fold record's time, deleting the
  // records, then the publish. Stopped at any point, the page still shows the same plan.
  // It also runs by itself (saveSnapshot(true)) when the owner or an editor opens a plan that has changed since the
  // snapshot and whose snapshot is over a day old or over 30 records behind (snapshotDue), once both collections have
  // come from the store rather than the cache. A lease on statuses/_snapshot keeps two tabs or devices from saving at
  // once, and the publish's own conflict check backs it up. One try per page load: a failure shows on the line.
  var SKELETON = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}</style></head><body>';
  var HEAD = '<meta name="claude:viewport-fit-sides" content="cover">\n<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap">\n<link rel="stylesheet" href="plan.css">\n';
  var bar = null, barNote = null, barBtn = null, barError = '', artifact = null, artifactAsked = false;
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function snapshotBar() {
    if (hub.mode !== 'db' || !hub.canEdit || !hub.model) { if (bar && bar.parentNode) bar.parentNode.removeChild(bar); return; }
    if (!artifactAsked) {
      artifactAsked = true;
      window.claude.use('artifact').then(function (a) { artifact = a; snapshotBar(); }, function () {});
      return;
    }
    if (!artifact) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.className = 'snapshot-bar';
      barNote = document.createElement('span');
      barNote.className = 'snapshot-note';
      barNote.setAttribute('aria-live', 'polite');
      barBtn = document.createElement('button');
      barBtn.type = 'button';
      barBtn.className = 'idea-btn snapshot-btn';
      barBtn.textContent = 'Save Snapshot';
      barBtn.title = 'Write the plan into the page, for its version history and for viewers who can’t load the database';
      barBtn.addEventListener('click', function () { saveSnapshot(false); });
      bar.appendChild(barNote);
      bar.appendChild(barBtn);
    }
    var header = main.querySelector('.plan-header');
    if (header && bar.parentNode !== header) header.appendChild(bar);
    var at = hub.model.M.snapshotAt, when = '';
    if (typeof at === 'string' && at) {
      var d = new Date(at);
      if (!isNaN(d)) when = d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear() + ', ' + ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    }
    bar.classList.toggle('is-error', !!barError);
    if (hub.saving) return;
    barNote.textContent = barError || ((when ? (hub.model.M.snapshotAuto ? 'Snapshot saved automatically ' : 'Snapshot ') + when : 'No snapshot yet') +
      (hub.differs ? ' · the plan has changed since' : ' · up to date'));
    barBtn.disabled = false;
    autoSnapshot();
  }
  var AUTO_AGE = 24 * 3600 * 1000, AUTO_RECORDS = 30, AUTO_WAIT = 1500, LEASE_MS = 90000;
  var tabId = 'tab-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36), autoState = '';
  // The update records the snapshot doesn't hold yet (fold records aren't updates).
  function pendingRecords(m, statuses) {
    var bakedAt = m.M.bakedAt || '';
    return (statuses || []).filter(function (r) {
      return r.id.charAt(0) !== '_' && isObj(r.body) && typeof r.body.at === 'string' && r.body.at > bakedAt && !r.body.fold;
    }).length;
  }
  // Why the snapshot should be saved now: 'records' (over 30 behind), 'age' (over a day old, or no time on it), or ''.
  function snapshotDue(m, statuses, differs, now) {
    if (!m || !differs) return '';
    if (pendingRecords(m, statuses) > AUTO_RECORDS) return 'records';
    var at = Date.parse(m.M.snapshotAt || '');
    return isNaN(at) || now - at > AUTO_AGE ? 'age' : '';
  }
  // A fold record from the last two minutes: another tab or device is saving a snapshot now.
  function foldUnderway(statuses, now) {
    return (statuses || []).some(function (r) {
      var t = isObj(r.body) && r.body.fold && typeof r.body.at === 'string' ? Date.parse(r.body.at) : NaN;
      return !isNaN(t) && now - t < 120000;
    });
  }
  // Called each time the line is drawn (only for the owner and editors, once the page has built from the database).
  // The wait, with a random part for two tabs opened together, lets the last records arrive and the other tab's fold
  // record show; it starts again later while a card is dragged or an edit box has the focus.
  function autoSnapshot() {
    if (autoState || barError || hub.saving || !hub.live.plan || !hub.live.statuses) return;
    if (!snapshotDue(hub.model, hub.statuses, hub.differs, Date.now())) return;
    autoState = 'waiting';
    setTimeout(function () {
      var active = document.activeElement;
      if (hub.dragging || waiting || (active && active.tagName === 'TEXTAREA' && main.contains(active))) {
        autoState = '';
        setTimeout(function () { if (bar && !hub.saving) autoSnapshot(); }, 5000);
        return;
      }
      autoState = 'done';
      var now = Date.now();
      if (hub.saving || barError || !snapshotDue(hub.model, hub.statuses, hub.differs, now) || foldUnderway(hub.statuses, now)) return;
      saveSnapshot(true);
    }, AUTO_WAIT + Math.floor(Math.random() * 1500));
  }
  // The lease that lets only one tab save at a time. Renewing works for the same tab, so a retry after a failure isn't
  // blocked. Where the store has no acquire, or it fails, the save goes ahead: the publish's conflict check still holds.
  function claim(db) {
    var ref = db.collection('statuses').doc('_snapshot');
    if (typeof ref.acquire !== 'function') return Promise.resolve(true);
    return ref.acquire({ holder: tabId, ttlMs: LEASE_MS }).then(function (r) { return !!(r && r.acquired); }, function () { return true; });
  }
  function safeStyles(css) {
    css = String(css || '').trim();
    return !css || /url\(|@import|<\/style|expression|javascript:|behavio(u)?r/i.test(css) ? '' : css;
  }
  function snapshotPage(m) {
    var holder = document.createElement('div');
    holder.appendChild(cleanPage(buildContent(m)));
    var css = safeStyles(m.M.styles);
    return SKELETON + '\n<title>' + esc(textOf(m.sub(m.M.title))) + '</title>\n' + HEAD +
      (css ? '<style>\n/* plan-specific */\n' + css + '\n</style>\n' : '') +
      '\n<main class="page">\n<!-- PLAN CONTENT START: replace everything between this marker and PLAN CONTENT END. -->\n' +
      holder.innerHTML + '<!-- PLAN CONTENT END -->\n</main>\n\n<script src="plan.js"></script>\n\n</body></html>';
  }
  // The entries with every record written in: statuses on the steps, notes at the end of their bodies, planned ideas gone.
  function foldPlan(m) {
    var F = clone(m.E);
    m.feats.forEach(function (ph) {
      Object.keys(F).forEach(function (k) { if (F[k].kind === 'idea' && F[k].feature === ph.body.feature) delete F[k]; });
    });
    Object.keys(m.status).forEach(function (sid) { if (has(F, sid)) F[sid].status = m.status[sid]; });
    Object.keys(m.notes).forEach(function (sid) {
      if (!has(F, sid)) return;
      var body = F[sid].body || '';
      m.notes[sid].forEach(function (h) { if (body.indexOf(h) < 0) body = body ? body + '\n' + h : h; });
      F[sid].body = body;
    });
    var entries = {}, writes = [];
    Object.keys(F).sort().forEach(function (k) {
      if (JSON.stringify(m.base[k]) !== JSON.stringify(F[k])) { entries[k] = F[k]; writes.push(['set', k, F[k]]); }
    });
    Object.keys(m.base).sort().forEach(function (k) {
      if (has(F, k)) return;
      entries[k] = null;
      writes.push(m.seeded[k] ? ['set', k, { deleted: true }] : ['delete', k]);
    });
    return { entries: entries, writes: writes };
  }
  function saveSnapshot(auto) {
    var db = hub.db;
    if (!hub.model || !db || !artifact || hub.saving) return;
    hub.saving = true;
    barError = '';
    barBtn.disabled = true;
    barNote.textContent = auto ? 'Saving a snapshot automatically…' : 'Saving the snapshot…';
    claim(db).then(function (ok) {
      if (ok) return writeSnapshot(db, auto);
      hub.saving = false;
      if (!auto) barError = 'Another tab is saving a snapshot. Try again in a minute.';
      refresh();
      snapshotBar();
    }).then(null, function () {
      hub.saving = false;
      barError = 'The snapshot couldn’t be saved. Try again in a moment.';
      snapshotBar();
    });
  }
  function writeSnapshot(db, auto) {
    // Built again from what has arrived by now: the page doesn't rebuild while saving, and the lease took a round trip.
    var m;
    try { m = buildModel(hub.plan, hub.statuses); } catch (e) { m = hub.model; }
    var fold = foldPlan(m), at = new Date().toISOString();
    var rec = { steps: {}, at: at, date: today(), fold: true,
      checkpoint: { entries: fold.entries, meta: { title: m.M.title, summary: m.M.summary || '' }, steps: {}, notes: {} } };
    var html = snapshotPage(Object.assign({}, m, { stamp: at }));
    var rid = recordId('fold');
    var old = (hub.statuses || []).filter(function (r) { return r.id.charAt(0) !== '_' && isObj(r.body) && typeof r.body.at === 'string' && r.body.at <= at; });
    var chain = JSON.stringify(rec).length > 250000 ? Promise.reject({ message: 'The plan has changed too much since the last snapshot to save in one go. Ask Claude to save it.' })
      : db.collection('statuses').doc(rid).set(rec);
    fold.writes.forEach(function (w) {
      chain = chain.then(function () { var ref = db.collection('plan').doc(w[1]); return w[0] === 'delete' ? ref['delete']() : ref.set(w[2]); });
    });
    chain = chain.then(function () {
      return db.collection('plan').doc('_plan').update({ version: m.version, updated: m.updated, bakedAt: at, snapshotAt: at,
        snapshotAuto: !!auto, statusOrder: true, title: m.M.title, summary: m.M.summary || '' });
    });
    old.concat([{ id: rid }]).forEach(function (r) {
      chain = chain.then(function () { return db.collection('statuses').doc(r.id)['delete'](); });
    });
    chain.then(function () {
      return artifact.publish(html);
    }).then(function () {
      barNote.textContent = auto ? 'Snapshot saved automatically. Reloading…' : 'Snapshot saved. Reloading…';
    }, function (e) {
      hub.saving = false;
      var code = e && e.code;
      if (code === 'conflict') { barNote.textContent = 'Someone published the page just now. Reloading…'; return; }
      barError = code === 'not_writer' || code === 'not_granted' || code === 'not_declared' || code === 'capability_disabled'
        ? 'This view can’t save snapshots.' : (e && e.message && !code ? e.message : 'The snapshot couldn’t be saved. Try again in a moment.');
      refresh();
      snapshotBar();
    });
  }
})();
