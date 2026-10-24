// node parity.js [PLANJS] CASES.json (PLANJS defaults to ../skill/plan.js; CASES from scen.py with DUMP=<file>): plan.js's buildModel + buildContent (cleaning left out) and foldPlan against plan.py's.
const fs = require('fs'), path = require('path'), vm = require('vm');
const args = process.argv.slice(2), CASES = args.pop(), PLANJS = args[0] || path.join(__dirname, '..', 'skill', 'plan.js');
let src = fs.readFileSync(PLANJS, 'utf8');
src = src.replace("if (!main) return;", "");
const end = src.lastIndexOf('})();');
src = src.slice(0, end) + "cleanFragment = function (h) { return h; }; textOf = function (h) { return String(h).replace(/<[^>]+>/g, '').trim(); }; globalThis.__api = { buildModel, buildContent, foldPlan, tokenizeHtml };\n" + src.slice(end);
const fakeEl = () => ({ childNodes: [], appendChild() {}, querySelector() { return null; }, querySelectorAll() { return []; }, innerHTML: '' });
const ctx = { console, setTimeout, Promise, JSON, Object, Array, String, Math, Date, RegExp, parseInt, isNaN };
ctx.window = ctx; ctx.globalThis = ctx;
ctx.document = { querySelector: () => fakeEl(), getElementById: () => null, createElement: fakeEl, querySelectorAll: () => [], addEventListener() {} };
ctx.location = { hash: '' };
vm.createContext(ctx); vm.runInContext(src, ctx);
const api = ctx.__api, cases = JSON.parse(fs.readFileSync(CASES, 'utf8'));
let bad = 0;
cases.forEach((c, i) => {
  const m = api.buildModel(c.plan, c.statuses), html = api.buildContent(m);
  const f = api.foldPlan(m);
  const tk = api.tokenizeHtml("<p>See 3.6 and F7.2, F8, steps 3.2 and 3.6 (3.6). Not 1.5 days, v3.6, version 3.6, 3.6 s, 1.0 → 1.1, 3.6.1, <code>3.6</code>.</p>", m.idOf, m.fids);
  const errs = [];
  if (html !== c.content) {
    const a = html.split('\n'), b = c.content.split('\n');
    const j = a.findIndex((x, k) => x !== b[k]);
    errs.push(`content differs at line ${j}: js ${JSON.stringify(a[j]).slice(0, 160)} | py ${JSON.stringify(b[j]).slice(0, 160)}`);
  }
  if (m.version !== c.version) errs.push(`version js ${m.version} py ${c.version}`);
  const norm = o => JSON.stringify(Object.keys(o).sort().map(k => [k, o[k] && JSON.stringify(Object.keys(o[k]).sort().map(x => [x, o[k][x]]))]));
  if (norm(f.entries) !== norm(c.fold)) errs.push(`fold entries differ: js ${Object.keys(f.entries).sort()} py ${Object.keys(c.fold).sort()}`);
  if (tk !== c.tokens) errs.push(`tokens js ${tk}`);
  if (errs.length) { bad++; console.log(`case ${i}: FAIL`); errs.forEach(e => console.log('  ' + e)); }
});
console.log(`${cases.length - bad} of ${cases.length} cases match`);
process.exit(bad ? 1 : 0);
