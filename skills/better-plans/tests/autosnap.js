// node autosnap.js [PLANJS DBDIR] (defaults ../skill/plan.js and sample-db): the page's automatic snapshot (Scheduled Snapshots F1.2) run for real against a fake
// database, user and publish shared between "tabs". Each tab is plan.js in its own vm context with a minimal DOM;
// cleaning and swapping are stubbed as in parity.js, and timers run 50x faster. Checks: an up-to-date plan and a recently
// snapshotted one don't publish, a day-old or 31-records-behind one publishes once and says so, a viewer who can't edit
// never writes, two tabs (with and without the store's lease) publish once, a cache-only first answer waits for the
// store, and the "saved automatically" line after the reload.
const fs = require('fs'), path = require('path'), vm = require('vm');
const SRC = fs.readFileSync(process.argv[2] || path.join(__dirname, '..', 'skill', 'plan.js'), 'utf8'), DB = process.argv[3] || path.join(__dirname, 'sample-db');
const FAST = 50, DAY = 864e5;

function loadDir(dir) {
  const out = {};
  for (const c of ['plan', 'statuses']) {
    out[c] = {};
    const d = path.join(dir, c);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) out[c][f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'));
  }
  return out;
}
const iso = t => new Date(t).toISOString();
const clone = x => JSON.parse(JSON.stringify(x));

// One store shared by every tab: collections of documents, live listeners, leases, and the published version.
function makeStore(docs, opts) {
  const s = { cols: clone(docs), listeners: [], leases: {}, version: 1, publishes: [], conflicts: 0, writes: [], acquire: opts.acquire !== false };
  s.notify = col => setTimeout(() => s.listeners.filter(l => l.col === col).forEach(l => l.deliver(false)), 1);
  return s;
}
function makeDb(s, tab) {
  function docRef(col, id) {
    const r = {
      id,
      set(data) { s.writes.push([tab.name, 'set', col, id]); (s.cols[col] = s.cols[col] || {})[id] = clone(data); s.notify(col); return Promise.resolve(); },
      update(data) {
        s.writes.push([tab.name, 'update', col, id]);
        if (!s.cols[col] || !s.cols[col][id]) return Promise.reject({ code: 'invalid_argument' });
        Object.assign(s.cols[col][id], clone(data)); s.notify(col); return Promise.resolve();
      },
      delete() { s.writes.push([tab.name, 'delete', col, id]); if (s.cols[col]) delete s.cols[col][id]; s.notify(col); return Promise.resolve(); },
      get() { const b = s.cols[col] && s.cols[col][id]; return Promise.resolve({ id, exists: !!b, data: () => b && clone(b) }); }
    };
    if (s.acquire) r.acquire = function (o) {
      const key = col + '/' + id, now = Date.now(), held = s.leases[key];
      if (held && held.until > now && held.holder !== o.holder) return Promise.resolve({ acquired: false, expiresAt: iso(held.until) });
      s.leases[key] = { holder: o.holder, until: now + (o.ttlMs || 30000) };
      s.writes.push([tab.name, 'acquire', col, id]);
      return Promise.resolve({ acquired: true, version: 1, holder: o.holder });
    };
    return r;
  }
  return {
    collection(col) {
      return {
        doc: id => docRef(col, id),
        onSnapshot(next) {
          const l = { col, deliver(fromCache, docs) {
            const body = docs || s.cols[col] || {};
            next({ docs: Object.keys(body).map(id => ({ id, data: () => clone(body[id]) })), metadata: { fromCache, hasPendingWrites: false } });
          } };
          s.listeners.push(l);
          if (tab.cacheFirst && tab.cacheFirst[col]) setTimeout(() => l.deliver(true, tab.cacheFirst[col]), 1);
          setTimeout(() => l.deliver(false), tab.liveDelay || 2);
          return () => {};
        }
      };
    }
  };
}
function el() {
  const e = { childNodes: [], children: [], attrs: {}, textContent: '', disabled: false, html: '',
    classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
    appendChild(c) { e.childNodes.push(c); c.parentNode = e; return c; }, removeChild(c) { e.childNodes = e.childNodes.filter(x => x !== c); },
    setAttribute(k, v) { e.attrs[k] = v; }, getAttribute(k) { return e.attrs[k] || null; }, addEventListener() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, contains() { return false; }, cloneNode() { return e; } };
  Object.defineProperty(e, 'innerHTML', { get() { return e.childNodes.map(c => c.html || '').join(''); }, set(v) { e.html = v; } });
  return e;
}

// Opens the plan in a new tab: plan.js runs, the fake runtime answers. Resolves the tab after `ms`.
function openTab(s, name, o) {
  const tab = Object.assign({ name, published: null, line: () => tab.api.line() }, o);
  const header = el();
  const main = el();
  main.querySelector = sel => (sel === '.plan-header' ? header : null);
  let src = SRC.replace("if (!main) return;", "");
  const end = src.lastIndexOf('})();');
  src = src.slice(0, end) +
    "cleanPage = function (h) { var f = { html: h }; f.cloneNode = function () { return { html: h }; }; return f; };" +
    "cleanFragment = function (h) { return h; }; swap = function () {}; textOf = function (h) { return String(h).replace(/<[^>]+>/g, '').trim(); };" +
    "original = globalThis.__original;" +
    "globalThis.__api = { buildModel: buildModel, buildContent: buildContent, line: function () { return barNote ? barNote.textContent : null; }, hub: hub };\n" +
    src.slice(end);
  const art = { publish(html) {
    if (s.version !== tab.loadedVersion) { s.conflicts++; return Promise.reject({ code: 'conflict' }); }
    s.version++; s.publishes.push({ tab: name, html }); tab.published = html; return Promise.resolve({ version: String(s.version) });
  } };
  const user = { canEdit: () => Promise.resolve(tab.canEdit !== false) };
  const ctx = { console, Promise, JSON, Object, Array, String, Math, Date, RegExp, parseInt, isNaN, Number,
    setTimeout: (f, ms) => setTimeout(f, Math.max(1, (ms || 0) / FAST)) };
  ctx.window = ctx; ctx.globalThis = ctx;
  ctx.document = { querySelector: sel => (sel === 'main.page' ? main : null), getElementById: () => null, createElement: el,
    querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}, activeElement: null, documentElement: el(), body: el() };
  ctx.location = { hash: '' };
  ctx.claude = { use: n => Promise.resolve(n === 'db' ? makeDb(s, tab) : n === 'user' ? user : n === 'artifact' ? art : null) };
  ctx.__original = tab.original || '';
  tab.loadedVersion = s.version;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  tab.api = ctx.__api;
  return tab;
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// ------------------------------------------------------------------------------------------------ the plan states
const base = loadDir(DB);
const now = Date.now();
function plan({ snapshotAgo, records, auto }) {
  const d = clone(base);
  Object.assign(d.plan._plan, { snapshotAt: iso(now - snapshotAgo), bakedAt: iso(now - snapshotAgo - 1000) });
  if (auto) d.plan._plan.snapshotAuto = true;
  for (let i = 0; i < records; i++) d.statuses['r-test-' + i] = { steps: { '1.1': i % 2 ? 'done' : 'progress' }, at: iso(now - snapshotAgo + 1000 + i), date: '2026-10-20' };
  return d;
}
// The page's own copy of the content for a plan whose snapshot is up to date: what it builds from the database.
function contentOf(d, s) {
  const t = openTab(makeStore({ plan: {}, statuses: {} }, {}), 'probe', {});
  const m = t.api.buildModel(Object.entries(d.plan).map(([id, body]) => ({ id, body })), Object.entries(d.statuses).map(([id, body]) => ({ id, body })));
  return t.api.buildContent(m).trim();
}

const results = [];
const check = (name, ok, detail) => results.push([name, !!ok, detail]);
const folds = s => s.writes.filter(w => w[1] === 'set' && w[2] === 'statuses' && /-fold-/.test(w[3])).length;
const RUN = 400;   // ms of real time: 20 s of page time, past the longest wait (3 s) and the save

(async function () {
  // 1 up to date: the built content matches the page's copy
  let d = plan({ snapshotAgo: 3 * DAY, records: 0 }), s = makeStore(d, {});
  openTab(s, 'A', { original: contentOf(d) });
  await wait(RUN);
  check('up to date: no save', s.publishes.length === 0 && s.writes.length === 0, s.writes);

  // 2 changed since, but the snapshot is an hour old and 5 records behind
  d = plan({ snapshotAgo: 3600e3, records: 5 }); s = makeStore(d, {});
  let a = openTab(s, 'A', {});
  await wait(RUN);
  check('recent snapshot: no save', s.publishes.length === 0 && s.writes.length === 0 && /changed since/.test(a.line()), [s.writes, a.line()]);

  // 3 a day and a bit old, 2 records behind: one save, records folded, flag set, line says so
  d = plan({ snapshotAgo: DAY + 60e3, records: 2 }); s = makeStore(d, {});
  a = openTab(s, 'A', {});
  await wait(RUN);
  const meta = s.cols.plan._plan, left = Object.keys(s.cols.statuses).filter(k => k[0] !== '_');
  check('day old: one save', s.publishes.length === 1 && folds(s) === 1 && left.length === 0 && meta.snapshotAuto === true &&
    Date.parse(meta.snapshotAt) > now - 1000 && meta.bakedAt === meta.snapshotAt && /saved automatically/.test(a.line()),
  [s.publishes.length, folds(s), left, meta.snapshotAuto, a.line()]);
  // ... and after the reload (the new version, the same store) the line says it was saved automatically, up to date
  const html = s.publishes.length ? s.publishes[0].html : '', inner = html.slice(html.indexOf('-->\n', html.indexOf('PLAN CONTENT START')) + 4, html.indexOf('<!-- PLAN CONTENT END'));
  const b = openTab(s, 'A2', { original: inner.trim() });
  await wait(RUN);
  check('after reload: line', s.publishes.length === 1 && /^Snapshot saved automatically \d+ \w+ \d{4}, \d\d:\d\d · up to date$/.test(b.line()), b.line());

  // 4 an hour old but 31 records behind: one save; 30 behind: none
  d = plan({ snapshotAgo: 3600e3, records: 31 }); s = makeStore(d, {});
  openTab(s, 'A', {});
  await wait(RUN);
  check('31 records: one save', s.publishes.length === 1 && folds(s) === 1, s.publishes.length);
  d = plan({ snapshotAgo: 3600e3, records: 30 }); s = makeStore(d, {});
  openTab(s, 'A', {});
  await wait(RUN);
  check('30 records: no save', s.publishes.length === 0, s.publishes.length);

  // 5 a viewer who can't edit: never writes or publishes
  d = plan({ snapshotAgo: 3 * DAY, records: 40 }); s = makeStore(d, {});
  a = openTab(s, 'A', { canEdit: false });
  await wait(RUN);
  check('viewer: no save', s.publishes.length === 0 && s.writes.length === 0 && a.line() === null, s.writes);

  // 6 two tabs open together, with the lease: one save, one fold, no conflict
  for (let i = 0; i < 5; i++) {
    d = plan({ snapshotAgo: 3 * DAY, records: 3 }); s = makeStore(d, {});
    openTab(s, 'A', {}); openTab(s, 'B', {});
    await wait(RUN);
    check('two tabs, lease: one save (run ' + (i + 1) + ')', s.publishes.length === 1 && folds(s) === 1 && s.conflicts === 0, [s.publishes.length, folds(s), s.conflicts]);
  }

  // 7 two tabs without acquire (an older runtime): one publish wins, at most one conflict
  for (let i = 0; i < 5; i++) {
    d = plan({ snapshotAgo: 3 * DAY, records: 3 }); s = makeStore(d, { acquire: false });
    openTab(s, 'A', {}); openTab(s, 'B', {});
    await wait(RUN);
    check('two tabs, no lease: one publish (run ' + (i + 1) + ')', s.publishes.length === 1, [s.publishes.length, folds(s), s.conflicts]);
  }

  // 8 the cache answers first with an up-to-date-looking plan, the store later: the save waits for the store
  d = plan({ snapshotAgo: 3 * DAY, records: 3 }); s = makeStore(d, {});
  a = openTab(s, 'A', { cacheFirst: { plan: d.plan, statuses: {} }, liveDelay: 3000 / FAST * 3 });
  await wait(40);
  const early = s.writes.length;
  await wait(RUN + 200);
  check('cache first: waits for the store', early === 0 && s.publishes.length === 1 && Object.keys(s.cols.statuses).filter(k => k[0] !== '_').length === 0, [early, s.publishes.length]);

  // 9 the button in the second tab while the first is saving: refused with a message, no second fold
  d = plan({ snapshotAgo: 3 * DAY, records: 3 }); s = makeStore(d, {});
  s.leases['statuses/_snapshot'] = { holder: 'someone-else', until: Date.now() + 90000 };
  a = openTab(s, 'A', {});
  await wait(RUN);
  check('lease held elsewhere: auto skips quietly', s.publishes.length === 0 && folds(s) === 0 && /changed since/.test(a.line()), [s.publishes.length, a.line()]);

  results.forEach(([n, ok, det]) => console.log((ok ? 'PASS ' : 'FAIL ') + n + (ok ? '' : '   ' + JSON.stringify(det))));
  console.log(results.filter(r => r[1]).length + ' of ' + results.length + ' passed');
  process.exit(results.every(r => r[1]) ? 0 : 1);
})();
