// The full performance audit's timings (docs/performance-audit.md): times every everyday action in
// the built app, from the input to the frame that shows the result, and prints each against its
// budget and against the last full audit on this PC (perf-results/baseline.json, not committed:
// timings only compare on the machine that made them).
//
// Usage:
//   npm run perf                      every action (about 10 minutes)
//   npm run perf -- brush save        only actions whose id, part of an id, or group matches
//   npm run perf -- --list            the actions and their groups
// Options: --exe <path> (default: the release build), --runs <n> (runs per action),
//   --baseline (save this run as the full audit's baseline).
//
// Drives the page through WebView2's debugging port like native-check.mjs, with its own data
// folder. It replaces whatever is on the clipboard, and the capture timing covers the screens with
// the capture overlay for a moment. Keep the app's window uncovered while it runs: WebView2 slows
// its frames down when the window is hidden. Windows only.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, crc32 } from 'node:zlib';
import { attach, fillFileDialog, helper, launch, overlay, ps, screen, sleep } from './native-driver.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RESULTS = join(root, 'perf-results');
const BASELINE = join(RESULTS, 'baseline.json');

// ---------- Arguments ----------

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  argv.splice(i, 1);
  return true;
};
const option = (name) => {
  const i = argv.indexOf(name);
  if (i < 0) return null;
  const [, value] = argv.splice(i, 2);
  return value;
};
const listOnly = flag('--list');
const saveBaseline = flag('--baseline');
const exe = resolve(root, option('--exe') ?? join('src-tauri', 'target', 'release', 'sketch.exe'));
const runsArg = option('--runs');
const runsOverride = runsArg ? Number(runsArg) || null : null;
const wanted = argv.map((a) => a.toLowerCase());

// ---------- The actions ----------

const FORMATS = ['png', 'jpeg', 'webp', 'bmp', 'sktch'];
const EXT = { png: 'png', jpeg: 'jpg', webp: 'webp', bmp: 'bmp', sktch: 'sktch' };
// Drawing tools: 'stroke' and 'drag' tools are dragged along a wavy path; 'click' tools are clicked once.
const DRAW = [
  ['pencil', 'stroke'],
  ['brush', 'stroke'],
  ['eraser', 'stroke'],
  ['highlight', 'stroke'],
  ['blur', 'stroke'],
  ['pixelate', 'stroke'],
  ['rectangle', 'drag'],
  ['ellipse', 'drag'],
  ['polygon', 'drag'],
  ['star', 'drag'],
  ['line', 'drag'],
  ['arrow', 'drag'],
  ['callout', 'drag'],
  ['spotlight', 'drag'],
  ['select-rect', 'drag'],
  ['select-free', 'drag'],
  ['crop', 'drag'],
  ['fill', 'click'],
  ['magic-wand', 'click'],
  ['picker', 'click'],
  ['marker', 'click'],
  ['text', 'click'],
];
const SIZES = { small: [800, 600], '4k': [3840, 2160], '8k': [7680, 4320] };
// Time budgets for the 8K picture are this many times the 4K ones: it has four times the pixels.
// Frame rate and pointer lag budgets are the same at every size.
const BIG = 4;

/** Every action: id, groups it's run by, what it times, and where it runs ('own' starts its own app). */
const ACTIONS = [
  { id: 'startup', groups: ['start'], label: 'Start-up to a canvas ready to draw on', where: 'own' },
  { id: 'capture', groups: ['start'], label: 'Capture keys to the frozen screen, with Sketch closed', where: 'own' },
  { id: 'capture-open', groups: ['start'], label: "Click a capture's notification to the capture on screen, with Sketch closed", where: 'own' },
  { id: 'shift-open', groups: ['start'], label: 'Tap Left Shift after a capture to the capture on screen, with Sketch closed', where: 'own' },
  { id: 'open-4k', groups: ['start', 'files'], label: 'Open a 4K photo from Explorer while Sketch runs', where: 'main' },
  { id: 'tool-change', groups: ['ui'], label: 'Change tool with its key (slowest of 10 tools)', where: 'main' },
  { id: 'size-change', groups: ['ui'], label: 'Change the brush size with [ and ]', where: 'main' },
  { id: 'label-drag', groups: ['ui'], label: 'Drag an options bar label with a shape picked, to the restyled shape', where: 'main' },
  { id: 'colour-swap', groups: ['ui', 'colour'], label: 'Swap colours with X', where: 'main' },
  { id: 'colour-popover', groups: ['ui', 'colour'], label: 'Open the colour popover', where: 'main' },
  { id: 'colour-swatch', groups: ['ui', 'colour'], label: 'Pick a swatch in the colour popover', where: 'main' },
  { id: 'menu-open', groups: ['ui'], label: 'Open the File menu', where: 'main' },
  { id: 'palette-open', groups: ['ui'], label: 'Open the command palette', where: 'main' },
  { id: 'settings-open', groups: ['ui'], label: 'Open Settings', where: 'main' },
  ...['4k', '8k'].flatMap((s) => [
    { id: `paste-${s}`, groups: ['files', s], label: `Paste a ${s.toUpperCase()} screenshot into a new picture`, where: 'main' },
    { id: `paste-onto-${s}`, groups: ['files', s], label: `Paste a ${s.toUpperCase()} screenshot onto a ${s.toUpperCase()} picture`, where: 'main' },
    ...FORMATS.map((f) => ({ id: `save-${s}-${f}`, groups: ['files', 'save', s], label: `Save a ${s.toUpperCase()} photo as ${f.toUpperCase()}`, where: 'main' })),
    { id: `copy-${s}`, groups: ['files', s], label: `Copy the whole ${s.toUpperCase()} picture`, where: 'main' },
    { id: `zoom-${s}`, groups: ['view', s], label: `Zoom in on a ${s.toUpperCase()} picture`, where: 'main' },
    { id: `undo-${s}`, groups: ['edit', s], label: `Undo a brush stroke on a ${s.toUpperCase()} picture`, where: 'main' },
    { id: `redo-${s}`, groups: ['edit', s], label: `Redo a brush stroke on a ${s.toUpperCase()} picture`, where: 'main' },
    { id: `invert-${s}`, groups: ['edit', 'adjust', s], label: `Invert the colours of a ${s.toUpperCase()} picture`, where: 'main' },
    ...DRAW.map(([t, kind]) => ({ id: `${t}-${s}`, groups: ['draw', kind, s], label: `${t} on a ${s.toUpperCase()} picture`, where: 'main', tool: t, kind, size: s })),
    { id: `autosave-${s}`, groups: ['files', s], label: `Longest pause while autosave writes a ${s.toUpperCase()} picture`, where: 'main' },
  ]),
  { id: 'close', groups: ['start'], label: 'Close Sketch', where: 'own' },
];

const matches = (a) => wanted.length === 0 || wanted.some((w) => a.id === w || a.id.startsWith(`${w}-`) || a.groups.includes(w) || a.id.split('-').includes(w) || (a.tool && a.tool === w));
const chosen = ACTIONS.filter(matches);

if (listOnly) {
  for (const a of ACTIONS) console.log(`${a.id.padEnd(22)} ${a.groups.join(', ').padEnd(24)} ${a.label}`);
  process.exit(0);
}
if (chosen.length === 0) {
  console.error(`No action matches ${wanted.join(' ')}. See npm run perf -- --list`);
  process.exit(1);
}
if (!existsSync(exe)) {
  console.error(`App not found at ${exe}. Build it first with: npm run tauri build -- --no-bundle`);
  process.exit(1);
}

// ---------- Results ----------

const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : null;
/** results[actionId][metric] = { value, unit, budget, higher } */
const results = {};
const details = {};
let failures = 0;
let slower = 0;

function report(id, metric, value, unit, budget, higher = false) {
  (results[id] ??= {})[metric] = { value: value === null ? null : Math.round(value * 10) / 10, unit, budget, higher };
  const ok = value !== null && (budget === null || (higher ? value >= budget : value <= budget));
  if (!ok) failures++;
  const shown = value === null ? 'none' : `${value.toFixed(unit === 'fps' ? 0 : 1)} ${unit}`;
  const lim = budget === null ? '' : `${higher ? '≥' : '≤'} ${budget} ${unit}`;
  let vs = '';
  const old = baseline?.results?.[id]?.[metric]?.value;
  if (typeof old === 'number' && value !== null && old > 0) {
    const change = ((value - old) / old) * 100;
    // Slower by over 10%, and by more than 1 ms or 1 fps, which is noise.
    const worse = higher ? old - value > 1 && -change > 10 : value - old > 1 && change > 10;
    if (worse) slower++;
    vs = `audit ${old}${worse ? `  ${change > 0 ? '+' : ''}${change.toFixed(0)}% SLOWER` : `  ${change > 0 ? '+' : ''}${change.toFixed(0)}%`}`;
  }
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${`${id} ${metric}`.padEnd(30)} ${shown.padStart(10)}  ${lim.padEnd(12)} ${vs}`);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)] : null;
};
const pct = (xs, p) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null;
};
const runs = (n) => runsOverride ?? n;

// ---------- Test pictures ----------

/** A photo-like PNG: smooth colour gradients with a little noise, so fills spread and saves work for it. */
function photo(width, height) {
  const row = 1 + width * 3;
  const raw = Buffer.alloc(row * height);
  let seed = 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const n = (seed >> 16) % 5;
      const i = y * row + 1 + x * 3;
      const u = x / width;
      const v = y / height;
      raw[i] = 40 + 160 * u + n;
      raw[i + 1] = 60 + 120 * v + n;
      raw[i + 2] = 200 - 120 * Math.abs(u - v) + n;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
}

const work = mkdtempSync(join(tmpdir(), 'sketch-perf-'));
const pictures = {};
const pictureFor = (size) => {
  if (!pictures[size]) {
    pictures[size] = join(work, `photo-${size}.png`);
    writeFileSync(pictures[size], photo(...SIZES[size]));
  }
  return pictures[size];
};

/** Puts a picture on the clipboard as screenshot tools do: as a PNG and as a bitmap. */
function copyScreenshot(path) {
  const q = `'${path.replace(/'/g, "''")}'`;
  ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$d = New-Object Windows.Forms.DataObject
$d.SetData('PNG', $false, (New-Object IO.MemoryStream(,[IO.File]::ReadAllBytes(${q}))))
$d.SetImage([Drawing.Image]::FromFile(${q}))
[Windows.Forms.Clipboard]::SetDataObject($d, $true)`);
}

// ---------- Driving the page ----------

const CTRL = 2;
const SHIFT = 8;

// Page helpers. `arm` times from the next input event of a type (its timestamp) to the start of
// the first frame where done() is true, which is the frame that shows the result. `stroke*`
// records frame times, and how long each pointer move waits for the frame that draws it.
const PAGE = `(() => {
  if (window.__perf) return true;
  const p = (window.__perf = {});
  p.arm = (type, done) => {
    p.result = new Promise((resolve, reject) => {
      let t0 = null;
      addEventListener(type, (e) => { if (t0 === null) t0 = e.timeStamp; }, { capture: true, once: true });
      const end = performance.now() + 15000;
      const frame = () => {
        const now = performance.now();
        if (t0 !== null && done()) return resolve(now - t0);
        if (now > end) return reject(new Error(t0 === null ? 'no input arrived' : 'the result never showed'));
        requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    });
    return true;
  };
  p.strokeStart = () => {
    p.frames = [];
    p.lags = [];
    let pending = null;
    let last = performance.now();
    p.rec = true;
    p.onMove = (e) => { if (pending === null) pending = e.timeStamp; };
    addEventListener('pointermove', p.onMove, true);
    const tick = () => {
      if (!p.rec) return;
      const t = performance.now();
      p.frames.push(t - last);
      last = t;
      if (pending !== null) { p.lags.push(t - pending); pending = null; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return true;
  };
  p.strokeEnd = () => {
    p.rec = false;
    removeEventListener('pointermove', p.onMove, true);
    return { frames: p.frames.slice(2), lags: p.lags };
  };
  return true;
})()`;

let app = null;
const S = 'window.sketch';

const ev = (expr) => app.evaluate(expr);
const arm = (type, done) => ev(`window.__perf.arm(${JSON.stringify(type)}, ${done})`);
const result = () => ev('window.__perf.result');

/** A key press with its real key code, for keys native-driver's press doesn't know. */
async function key(keyName, code, keyCode, mods = 0) {
  const base = { key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers: mods };
  await app.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
  await app.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

async function click(x, y) {
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

/** The centre of the first element matching a selector, in the page's CSS pixels. */
const centre = (sel) => ev(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);

/** Where the picture is on screen, in CSS pixels. */
const pictureBox = () =>
  ev(`(() => {
    const v = ${S}.app.viewport, d = ${S}.app.doc, c = document.querySelector('canvas.view').getBoundingClientRect();
    return { x: c.x + v.panX, y: c.y + v.panY, w: d.width * v.zoom, h: d.height * v.zoom };
  })()`);

async function waitUntil(what, fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Closes popovers, dialogs and selections, so the next action starts from a plain canvas. */
async function settle() {
  for (let i = 0; i < 2; i++) {
    await app.press('Escape');
    await sleep(60);
  }
}

const untouched = () => ev(`${S}.app.docIsNew && ${S}.app.history.position === 0 && !${S}.app.history.dirty`);

/** A new, untouched picture, in a tab of its own (F14); the other tabs close unsaved, so timings never carry their memory. */
async function newPicture() {
  await settle();
  await ev(`${S}.run('file.new')`);
  await waitUntil('a new picture', async () => {
    const s = await app.state();
    if (s.dialog === 'Save your changes?') await app.clickButton("Don't Save");
    return untouched();
  });
  await ev(`(async () => {
    const t = ${S}.tabs;
    const keep = t.list[t.active];
    for (const x of [...t.list]) if (x !== keep) {
      x.history.markSaved();
      x.quickCapture = true;
      await ${S}.closeTab(t.list.indexOf(x));
    }
  })()`);
  current = null;
}

let current = null;
/** Makes the current picture the test photo of a size (by pasting it into a new picture). */
async function usePicture(size) {
  if (current === size) return settle();
  await newPicture();
  copyScreenshot(pictureFor(size));
  await app.press('v', CTRL, ['paste']);
  const [w, h] = SIZES[size];
  await app.waitFor(`the ${size} picture`, (s) => s.size === `${w} × ${h} px`, 30000);
  await sleep(300);
  current = size;
}

/** A short brush stroke on the picture, to change it. */
async function scribble() {
  await useTool('brush');
  const b = await pictureBox();
  const before = await ev(`${S}.app.history.position`);
  await app.drag(b.x + b.w * 0.4, b.y + b.h * 0.45, b.x + b.w * 0.6, b.y + b.h * 0.55);
  await waitUntil('the stroke', async () => (await ev(`${S}.app.history.position`)) !== before);
}

/** Times one input, from `type` to the frame where `done` is true. `done` is page code for a function made at arm time. */
async function timed(type, done, input) {
  await arm(type, done);
  await input();
  return result();
}

const position = `${S}.app.history.position`;

// Tools alone in their rail slot are picked by the slot's command; the rest have one of their own.
const ALONE = ['pencil', 'brush', 'eraser', 'fill', 'picker', 'text', 'crop'];
async function useTool(tool) {
  await ev(`${S}.run('${ALONE.includes(tool) ? 'slot' : 'tool'}.${tool}')`);
  const want = { 'select-rect': 'rectangle select', 'select-free': 'freehand select', 'magic-wand': 'magic wand', picker: 'colour picker', highlight: 'highlighter' }[tool] ?? tool;
  const name = () => ev(`(document.querySelector('.tool-name')?.textContent ?? '').toLowerCase()`);
  await waitUntil(`the ${tool} tool`, async () => (await name()).includes(want), 3000);
}
const changedFrom = (expr) => `(() => { const before = ${expr}; return () => ${expr} !== before; })()`;

// ---------- The main session's actions ----------

async function openFromExplorer() {
  const file = pictureFor('4k');
  const times = [];
  for (let i = 0; i < runs(3); i++) {
    if (!(await untouched())) await newPicture();
    const t0 = performance.now();
    const child = spawn(exe, [file], { stdio: 'ignore', cwd: work, env: { ...process.env, SKETCH_DATA_DIR: join(work, 'data') } });
    child.on('error', () => {});
    await waitUntil('the photo to open', async () => (await app.windowTitles()).includes('photo-4k.png - Sketch'));
    // The frame that shows it.
    await ev('new Promise((r) => requestAnimationFrame(() => r(true)))');
    times.push(performance.now() - t0);
    await sleep(300);
    await newPicture();
  }
  report('open-4k', 'time', median(times), 'ms', 1000);
}

async function toolChange() {
  await usePicture('small');
  // Starts away from the Brush, the tool a new window starts with.
  const keys = ['P', 'B', 'E', 'G', 'I', 'T', 'U', 'A', 'M', 'C'];
  const per = {};
  for (let r = 0; r < runs(3); r++) {
    for (const k of keys) {
      const ms = await timed('keydown', changedFrom(`document.querySelector('.tool-name')?.textContent`), () => app.press(k.toLowerCase()));
      (per[k] ??= []).push(ms);
      await sleep(40);
    }
  }
  const medians = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, median(v)]));
  const worst = Object.entries(medians).sort((a, b) => b[1] - a[1])[0];
  details['tool-change'] = medians;
  report('tool-change', 'time', worst[1], 'ms', 17);
  console.log(`      slowest: ${worst[0]}; ${Object.entries(medians).map(([k, v]) => `${k} ${v.toFixed(1)}`).join(', ')}`);
  await useTool('brush');
}

async function sizeChange() {
  await usePicture('small');
  await useTool('brush');
  await sleep(100);
  const times = [];
  for (let i = 0; i < runs(5); i++) {
    const up = i % 2 === 0;
    times.push(
      await timed('keydown', changedFrom(`document.querySelector('.opt.range .num')?.value`), () =>
        key(up ? ']' : '[', up ? 'BracketRight' : 'BracketLeft', up ? 221 : 219),
      ),
    );
    await sleep(40);
  }
  report('size-change', 'time', median(times), 'ms', 17);
}

async function labelDrag() {
  await usePicture('small');
  await useTool('rectangle');
  const b = await pictureBox();
  await app.drag(b.x + b.w * 0.2, b.y + b.h * 0.2, b.x + b.w * 0.5, b.y + b.h * 0.5);
  await sleep(200);
  // The first drag label of the Rectangle's bar (Outline): press, move 10 px to start the drag, wait for the pointer to lock.
  const [x, y] = await centre('.opt.drag .scrub');
  const mouse = (type, px, buttons) => app.send('Input.dispatchMouseEvent', { type, x: px, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  await mouse('mousePressed', x, 1);
  await mouse('mouseMoved', x + 10, 1);
  await waitUntil('the drag to start', async () => (await ev(`document.querySelector('.opt.drag .scrub')?.dataset.lock ?? ''`)) !== '', 3000);
  await sleep(150);
  const times = [];
  const width = `${S}.app.doc.layers[0].objects[0].width`;
  for (let i = 0; i < runs(10); i++) {
    // Two pixels is one step: the shape's outline grows by 1.
    times.push(await timed('pointermove', changedFrom(width), () => mouse('mouseMoved', x + 12 + i * 2, 1)));
    await sleep(40);
  }
  await mouse('mouseReleased', x + 12 + runs(10) * 2, 0);
  await sleep(150);
  report('label-drag', 'time', median(times), 'ms', 17);
  // Back to the Brush, whose colours the colour actions after this one time.
  await useTool('brush');
}

async function colourSwap() {
  await usePicture('small');
  await useTool('brush');
  const times = [];
  for (let i = 0; i < runs(5); i++) {
    times.push(await timed('keydown', changedFrom(`${S}.app.primary`), () => app.press('x')));
    await sleep(40);
  }
  report('colour-swap', 'time', median(times), 'ms', 17);
}

async function colourPopover(withSwatch) {
  await usePicture('small');
  await useTool('brush');
  const open = [];
  const swatch = [];
  for (let i = 0; i < runs(5); i++) {
    const [x, y] = await centre('.opt.colors button');
    open.push(await timed('pointerdown', `() => !!document.querySelector('.color-popover')`, () => click(x, y)));
    await sleep(100);
    if (withSwatch) {
      const at = await ev(`(() => {
        const b = document.querySelector('.color-popover .swatch-btn:not(.on)');
        const r = b.getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      })()`);
      swatch.push(await timed('pointerdown', changedFrom(`${S}.app.primary`), () => click(...at)));
    }
    await settle();
    // The popover ignores a click on its colour button within half a second of closing.
    await sleep(600);
  }
  if (withSwatch) report('colour-swatch', 'time', median(swatch), 'ms', 17);
  else report('colour-popover', 'time', median(open), 'ms', 50);
}

async function popup(id, selector, input) {
  await usePicture('small');
  const times = [];
  for (let i = 0; i < runs(5); i++) {
    times.push(await timed(input.type, `() => !!document.querySelector(${JSON.stringify(selector)})`, input.go));
    await sleep(100);
    await settle();
    await sleep(200);
  }
  report(id, 'time', median(times), 'ms', 50);
}

async function pasteNew(size) {
  const times = [];
  const [w, h] = SIZES[size];
  for (let i = 0; i < runs(3); i++) {
    await newPicture();
    copyScreenshot(pictureFor(size));
    times.push(await timed('keydown', `() => document.querySelector('.st-size')?.textContent === '${w} × ${h} px'`, () => app.press('v', CTRL, ['paste'])));
    current = size;
    await sleep(300);
  }
  report(`paste-${size}`, 'time', median(times), 'ms', size === '4k' ? 200 : 200 * BIG);
}

async function pasteOnto(size) {
  await usePicture(size);
  const [w] = SIZES[size];
  const times = [];
  for (let i = 0; i < runs(3); i++) {
    copyScreenshot(pictureFor(size));
    times.push(await timed('keydown', `() => (document.querySelector('.st-selection')?.textContent ?? '').startsWith('${w}')`, () => app.press('v', CTRL, ['paste'])));
    await sleep(200);
    await app.press('Escape');
    await sleep(300);
  }
  report(`paste-onto-${size}`, 'time', median(times), 'ms', size === '4k' ? 200 : 200 * BIG);
}

async function saveAs(size, format) {
  // A fresh picture: one layer, so every format saves without asking about layers.
  await usePicture(size);
  const name = `saved-${size}.${EXT[format]}`;
  await app.press('s', CTRL | SHIFT);
  await app.waitFor('the Save As box', (s) => s.dialog === 'Save As');
  await ev(`(() => {
    const sel = document.querySelector('.dialog select');
    sel.value = ${JSON.stringify(format)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  await sleep(100);
  await ev(`document.querySelector('.dialog button.primary').click()`);
  fillFileDialog(app.pid, join(work, name));
  await app.waitFor(`${name} to be saved`, (s) => s.title === `${name} - Sketch`, 30000);
  const times = [];
  for (let i = 0; i < runs(3); i++) {
    await scribble();
    await app.waitFor('the change', (s) => s.title === `${name}* - Sketch`);
    times.push(await timed('keydown', `() => document.title === ${JSON.stringify(`${name} - Sketch`)}`, () => app.press('s', CTRL)));
    await sleep(200);
  }
  report(`save-${size}-${format}`, 'time', median(times), 'ms', size === '4k' ? 1000 : 1000 * BIG);
}

async function copyWhole(size) {
  await usePicture(size);
  const times = [];
  for (let i = 0; i < runs(3); i++) {
    // Each copy shows a toast; wait for the last one to go so the next is new.
    await waitUntil('the last toast to go', async () => !(await ev(`!!document.querySelector('.toast')`)), 15000);
    times.push(await timed('keydown', `() => (document.querySelector('.toast')?.textContent ?? '').startsWith('Copied the picture')`, () => app.press('c', CTRL | SHIFT)));
  }
  report(`copy-${size}`, 'time', median(times), 'ms', size === '4k' ? 500 : 500 * BIG);
}

async function zoom(size) {
  await usePicture(size);
  const times = [];
  for (let i = 0; i < runs(5); i++) {
    times.push(await timed('keydown', changedFrom(`${S}.app.viewport.zoom`), () => key('=', 'Equal', 187, CTRL)));
    await sleep(100);
    await key('0', 'Digit0', 48, CTRL);
    await sleep(200);
  }
  report(`zoom-${size}`, 'time', median(times), 'ms', 17);
}

async function undoRedo(size, which) {
  await usePicture(size);
  const times = [];
  for (let i = 0; i < runs(3); i++) {
    await scribble();
    const undo = await timed('keydown', changedFrom(position), () => app.press('z', CTRL));
    await sleep(150);
    const redo = await timed('keydown', changedFrom(position), () => app.press('y', CTRL));
    await sleep(150);
    times.push(which === 'undo' ? undo : redo);
  }
  report(`${which}-${size}`, 'time', median(times), 'ms', size === '4k' ? 100 : 100 * BIG);
}

async function invert(size) {
  await usePicture(size);
  const times = [];
  for (let i = 0; i < runs(3); i++) {
    times.push(await timed('keydown', changedFrom(position), () => app.press('i', CTRL | SHIFT)));
    await sleep(150);
    await app.press('z', CTRL);
    await sleep(300);
  }
  report(`invert-${size}`, 'time', median(times), 'ms', size === '4k' ? 100 : 100 * BIG);
}

/** What shows that a tool finished: page code for a function made at arm time, or null when nothing does. */
function finished(tool) {
  if (tool.startsWith('select') || tool === 'magic-wand') return changedFrom(`${S}.app.selection`);
  if (tool === 'picker') return changedFrom(`${S}.app.primary`);
  // A callout is a text box with a tail: it finishes with its text box open for typing.
  if (tool === 'text' || tool === 'callout') return `() => !!document.querySelector('textarea')`;
  if (tool === 'crop') return null;
  return changedFrom(position);
}

async function draw(a) {
  const { tool, kind, size } = a;
  await usePicture(size);
  await useTool(tool);
  await sleep(150);
  const done = finished(tool);
  const fps = [];
  const slow = [];
  const lag = [];
  const lagSlow = [];
  const finish = [];
  for (let r = 0; r < runs(kind === 'click' ? 5 : 2); r++) {
    const b = await pictureBox();
    if (tool === 'picker') await ev(`(${S}.app.primary = '#000000', true)`);
    const before = await ev(position);
    if (kind === 'click') {
      // Spread out, so fills and wands start somewhere new.
      const x = b.x + b.w * (0.3 + 0.1 * r);
      const y = b.y + b.h * (0.35 + 0.07 * r);
      finish.push(await timed('pointerdown', done, () => click(x, y)));
    } else {
      const x0 = b.x + b.w * 0.25;
      const y0 = b.y + b.h * 0.35;
      await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0, y: y0, button: 'none', buttons: 0 });
      await ev('window.__perf.strokeStart()');
      await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
      const start = Date.now();
      let x = x0;
      let y = y0;
      for (let i = 0; Date.now() - start < 1500; i++) {
        const t = (Date.now() - start) / 1500;
        x = b.x + b.w * (0.25 + 0.5 * t);
        // Wavy, and ending below and right of the start, so shapes get a size.
        y = b.y + b.h * (0.35 + 0.3 * t + 0.08 * Math.sin(t * Math.PI * 6));
        await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await sleep(4);
      }
      const rec = await ev('window.__perf.strokeEnd()');
      const total = rec.frames.reduce((s, f) => s + f, 0);
      fps.push((rec.frames.length / total) * 1000);
      slow.push(pct(rec.frames, 0.95));
      lag.push(median(rec.lags));
      lagSlow.push(pct(rec.lags, 0.95));
      if (done) await arm('pointerup', done);
      await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
      if (done) finish.push(await result());
    }
    await sleep(200);
    // Leave the picture as it was.
    if ((await ev(position)) !== before) {
      await app.press('z', CTRL);
      await waitUntil('the undo', async () => (await ev(position)) === before);
    }
    await settle();
    await sleep(100);
  }
  const f = size === '4k' ? 1 : BIG;
  const id = `${tool}-${size}`;
  if (kind !== 'click') {
    report(id, 'fps', median(fps), 'fps', 55, true);
    report(id, 'slowest 5% frame', median(slow), 'ms', 33);
    report(id, 'pointer lag', median(lag), 'ms', 17);
    report(id, 'slowest 5% lag', median(lagSlow), 'ms', 33);
  }
  if (finish.length) {
    const budget = tool === 'text' || tool === 'callout' ? 50 : tool === 'fill' || tool === 'magic-wand' ? 200 * f : kind === 'click' ? 50 * f : 100 * f;
    report(id, kind === 'click' ? 'time' : 'finish', median(finish), 'ms', budget);
  }
}

async function autosave(size) {
  await usePicture(size);
  await ev(`(() => {
    window.__long = [];
    window.__longObs?.disconnect();
    window.__longObs = new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); });
    window.__longObs.observe({ entryTypes: ['longtask'] });
    return true;
  })()`);
  await scribble();
  // Autosave waits for a quiet moment after a change, then writes.
  await sleep(6000);
  const longest = await ev('(window.__longObs.disconnect(), Math.max(0, ...window.__long))');
  report(`autosave-${size}`, 'longest pause', longest, 'ms', 100);
}

// ---------- Actions with their own app ----------

async function startup() {
  const dataDir = join(work, 'data-startup');
  const times = [];
  for (let i = 0; i < runs(5); i++) {
    const probe = join(work, `startup-probe-${i}`);
    const t0 = performance.now();
    const child = spawn(exe, [], { env: { ...process.env, SKETCH_STARTUP_PROBE: probe, SKETCH_DATA_DIR: dataDir }, stdio: 'ignore' });
    await waitUntil('the start-up probe', async () => existsSync(probe), 15000).catch((e) => {
      child.kill();
      throw e;
    });
    times.push(performance.now() - t0);
    await new Promise((r) => (child.exitCode !== null ? r() : child.on('exit', r)));
    await sleep(500);
  }
  details.startup = times.map((t) => Math.round(t));
  report('startup', 'time', median(times), 'ms', 1000);
}

async function capture() {
  const dir = join(work, 'data-capture');
  mkdirSync(dir, { recursive: true });
  app = await launch(exe, work, [], 'capture', { SKETCH_DATA_DIR: dir });
  let helperPid = 0;
  try {
    const answer = await ev(`window.__TAURI_INTERNALS__.invoke('set_shortcut', { kind: 'capture', keys: 'Alt+Shift+F10' }).then(() => 'made', (e) => String(e))`);
    if (answer !== 'made') throw new Error(`Couldn't set the capture keys: ${answer}`);
    const h = await helper.wait(work, dir);
    helperPid = helper.pid(work, h);
    await app.quit();
    app = null;
    await sleep(500);
    const times = [];
    for (let i = 0; i < runs(5); i++) {
      const ms = helper.timeOverlay(work, h, helperPid);
      if (ms < 0) throw new Error('The capture overlay never showed');
      times.push(ms);
      const o = await overlay.find(work, helperPid);
      overlay.key(work, o, 0x1b, 200, 200);
      await overlay.gone(work, o);
      await sleep(400);
    }
    report('capture', 'time', median(times), 'ms', 100);
  } finally {
    await app?.quit();
    app = null;
    if (helperPid) {
      try {
        process.kill(helperPid);
      } catch {}
    }
  }
}

/**
 * F12: with Sketch closed, each capture starts a hidden Sketch with it, so the notification's click
 * only shows it. Times the click (the helper's test message) to the window showing and to the start
 * of its first frame on screen. With `tap` (F16), a tap of Left Shift (sent with SendInput) instead,
 * 750 ms after the capture: as late in its second as is safe, so the hidden Sketch is ready.
 */
async function captureOpen(id = 'capture-open', tap = false) {
  const dir = join(work, `data-${id}`);
  mkdirSync(dir, { recursive: true });
  // Holds the notifications long enough to wait for the hidden Sketch to be ready.
  writeFileSync(join(dir, 'note-ms.txt'), '20000');
  app = await launch(exe, work, [], 'capture-open', { SKETCH_DATA_DIR: dir });
  const port = app.port;
  let helperPid = 0;
  const sketchPid = () => Number(ps(`Get-CimInstance Win32_Process -Filter "Name='sketch.exe'" | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' } | Select-Object -First 1 -ExpandProperty ProcessId`) || 0);
  try {
    const answer = await ev(`window.__TAURI_INTERNALS__.invoke('set_shortcut', { kind: 'capture', keys: 'Alt+Shift+F10' }).then(() => 'made', (e) => String(e))`);
    if (answer !== 'made') throw new Error(`Couldn't set the capture keys: ${answer}`);
    const h = await helper.wait(work, dir);
    helperPid = helper.pid(work, h);
    await app.quit();
    app = null;
    await sleep(500);
    const shown = [];
    const frames = [];
    for (let i = 0; i < runs(5); i++) {
      helper.keys(work, h);
      const o = await overlay.find(work, helperPid);
      let timed = null;
      if (tap) {
        // The tap 750 ms after the overlay closes, in the same call, so the hidden Sketch is ready.
        timed = overlay.dragTapShown(work, o, 200, 200, 600, 500, 750, exe);
      } else {
        overlay.drag(work, o, 200, 200, 600, 500);
      }
      await overlay.gone(work, o);
      let pid = 0;
      await waitUntil('the hidden Sketch', async () => (pid = sketchPid()) !== 0, 10000);
      if (!tap) {
        // Ready well before the notification goes.
        await sleep(2000);
        timed = helper.timeShown(work, h, pid);
      }
      const { posted, ms } = timed;
      if (ms < 0) throw new Error('Sketch never showed');
      shown.push(ms);
      app = await attach(port, pid);
      let at = null;
      await waitUntil('the first frame', async () => (at = await ev('window.sketchShownAt ?? null')) !== null, 5000);
      frames.push(at - posted);
      ps(`Stop-Process -Id ${pid} -Force`);
      await app.quit(3000);
      app = null;
      await sleep(500);
    }
    details[id] = { shown: shown.map(Math.round), frame: frames.map(Math.round) };
    report(id, 'window shown', median(shown), 'ms', 100);
    report(id, 'first frame', median(frames), 'ms', 100);
  } finally {
    await app?.quit();
    app = null;
    if (helperPid) {
      try {
        process.kill(helperPid);
      } catch {}
    }
  }
}

async function close() {
  const times = [];
  const shown = [];
  for (let i = 0; i < runs(3); i++) {
    // Its own data folder: the main session's autosaves would come back and ask to be saved.
    app = await launch(exe, work, [], 'close', { SKETCH_DATA_DIR: join(work, 'data-close') });
    await sleep(800);
    const out = screen(
      work,
      `$p = Get-Process -Id ${app.pid}; $h = [long]$p.MainWindowHandle
$sw = [Diagnostics.Stopwatch]::StartNew(); [SketchScreen]::Send($h, 16)
while ([SketchScreen]::Visible($h) -and $sw.ElapsedMilliseconds -lt 10000) { }
$gone = $sw.ElapsedMilliseconds; [void]$p.WaitForExit(10000); "$gone,$($sw.ElapsedMilliseconds)"`,
    );
    const [gone, exited] = out.split(',').map(Number);
    if (exited >= 10000) throw new Error("Sketch didn't close");
    shown.push(gone);
    times.push(exited);
    await app.quit(5000);
    app = null;
    await sleep(300);
  }
  report('close', 'window gone', median(shown), 'ms', 200);
  report('close', 'app exited', median(times), 'ms', 1000);
}

// ---------- Run ----------

const machine = {
  os: `Windows ${release()}`,
  cpu: cpus()[0]?.model.trim(),
  cores: cpus().length,
  memoryGB: Math.round(totalmem() / 2 ** 30),
};
let version = 'unknown';
try {
  version = execFileSync('git', ['-C', root, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  if (execFileSync('git', ['-C', root, 'status', '--porcelain', '--', '.'], { encoding: 'utf8' }).trim()) version += '+changes';
} catch {}

console.log(`Sketch ${version} on ${machine.cpu}, ${machine.cores} threads, ${machine.memoryGB} GB`);
console.log(`Timing ${chosen.length} action${chosen.length === 1 ? '' : 's'}${baseline ? `, compared with the audit of ${baseline.date} (${baseline.version})` : ''}\n`);

const has = (id) => chosen.some((a) => a.id === id);
const errors = [];
async function attempt(id, fn) {
  try {
    await fn();
  } catch (e) {
    errors.push(id);
    failures++;
    console.log(`ERROR ${id}: ${e.message}`);
    if (app) console.log(app.logs.slice(-5).map((l) => `      ${l}`).join('\n'));
    // Start the next action from a fresh picture.
    current = null;
  }
}

try {
  if (has('startup')) await attempt('startup', startup);
  if (has('capture')) await attempt('capture', capture);
  if (has('capture-open')) await attempt('capture-open', () => captureOpen());
  if (has('shift-open')) await attempt('shift-open', () => captureOpen('shift-open', true));

  const main = chosen.filter((a) => a.where === 'main');
  if (main.length) {
    app = await launch(exe, work);
    await ev(PAGE);
    await ev(`window.__TAURI_INTERNALS__.invoke('bring_to_front')`);
    machine.displayHz = Math.round(
      1000 / (await ev(`new Promise((r) => { const t = []; let last = 0; const f = (now) => { if (last) t.push(now - last); last = now; t.length < 60 ? requestAnimationFrame(f) : r(t.sort((a, b) => a - b)[30]); }; requestAnimationFrame(f); })`)),
    );
    console.log(`Display: ${machine.displayHz} Hz\n`);

    if (has('open-4k')) await attempt('open-4k', openFromExplorer);
    if (has('tool-change')) await attempt('tool-change', toolChange);
    if (has('size-change')) await attempt('size-change', sizeChange);
    if (has('label-drag')) await attempt('label-drag', labelDrag);
    if (has('colour-swap')) await attempt('colour-swap', colourSwap);
    if (has('colour-popover')) await attempt('colour-popover', () => colourPopover(false));
    if (has('colour-swatch')) await attempt('colour-swatch', () => colourPopover(true));
    if (has('menu-open')) await attempt('menu-open', async () => popup('menu-open', '.menu', { type: 'pointerdown', go: async () => click(...(await centre('.menu-wrap button'))) }));
    if (has('palette-open')) await attempt('palette-open', () => popup('palette-open', '.palette', { type: 'keydown', go: () => app.press('k', CTRL) }));
    if (has('settings-open')) await attempt('settings-open', () => popup('settings-open', '.settings-scroll', { type: 'keydown', go: () => app.press(',', CTRL) }));
    for (const size of ['4k', '8k']) {
      if (has(`paste-${size}`)) await attempt(`paste-${size}`, () => pasteNew(size));
      if (has(`paste-onto-${size}`)) await attempt(`paste-onto-${size}`, () => pasteOnto(size));
      for (const f of FORMATS) {
        if (has(`save-${size}-${f}`)) {
          current = null; // A fresh one-layer picture for each format.
          await attempt(`save-${size}-${f}`, () => saveAs(size, f));
        }
      }
      if (has(`copy-${size}`)) await attempt(`copy-${size}`, () => copyWhole(size));
      if (has(`zoom-${size}`)) await attempt(`zoom-${size}`, () => zoom(size));
      if (has(`undo-${size}`)) await attempt(`undo-${size}`, () => undoRedo(size, 'undo'));
      if (has(`redo-${size}`)) await attempt(`redo-${size}`, () => undoRedo(size, 'redo'));
      if (has(`invert-${size}`)) await attempt(`invert-${size}`, () => invert(size));
      for (const a of chosen.filter((a) => a.tool && a.size === size)) await attempt(a.id, () => draw(a));
      if (has(`autosave-${size}`)) await attempt(`autosave-${size}`, () => autosave(size));
    }
    await app.quit();
    app = null;
  }

  if (has('close')) await attempt('close', close);
} finally {
  await app?.quit();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
}

const date = new Date().toISOString().slice(0, 10);
const run = { date, version, machine, results, details };
mkdirSync(RESULTS, { recursive: true });
const file = join(RESULTS, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify(run, null, 2) + '\n');
if (saveBaseline) {
  // Keep the baseline's timings for actions this run skipped.
  const merged = { ...run, results: { ...(baseline?.results ?? {}), ...results } };
  writeFileSync(BASELINE, JSON.stringify(merged, null, 2) + '\n');
}

const metrics = Object.values(results).reduce((n, r) => n + Object.keys(r).length, 0);
console.log(`\n${metrics - (failures - errors.length)} of ${metrics} timings within budget${errors.length ? `, ${errors.length} action(s) failed to run (${errors.join(', ')})` : ''}.`);
if (slower) console.log(`${slower} timing(s) are over 10% slower than the last full audit.`);
console.log(`Saved to ${file}${saveBaseline ? ` and ${BASELINE}` : ''}`);
if (failures) process.exit(1);
