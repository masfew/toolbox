// Random edits in the built app, with undo and redo, checking after every step that the app is
// still answering, threw no errors, and the picture is still valid. At the end it undoes
// everything, checks the picture is back where it started, and redoes it all again.
// Usage: node scripts/fuzz-check.mjs [minutes] [path-to-exe]   (3 minutes by default; the
// Phase 6 goal is an hour without a crash: node scripts/fuzz-check.mjs 60)
//
// Drives the page through WebView2's debugging port like native-check.mjs, with its own data folder.
// The seed is printed, so a failure can be replayed with SKETCH_FUZZ_SEED. Windows only.
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { launch, sleep } from './native-driver.mjs';

const minutes = Number(process.argv[2] ?? 3);
const exe = resolve(process.argv[3] ?? join('src-tauri', 'target', 'release', 'sketch.exe'));
if (!existsSync(exe)) {
  console.error(`App not found at ${exe}. Build it first with: npm run tauri build`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'sketch-fuzz-'));

// A small seeded random number generator (mulberry32), so a run can be repeated.
const seed = Number(process.env.SKETCH_FUZZ_SEED ?? Math.floor(Math.random() * 2 ** 31));
let state = seed;
const random = () => {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = (list) => list[Math.floor(random() * list.length)];

/** Commands run straight from the command list: ones that change the picture without asking anything. */
const COMMANDS = [
  'edit.selectAll', 'edit.delete', 'edit.duplicate', 'edit.front', 'edit.back', 'edit.rasterize', 'edit.swapColors',
  'arrange.left', 'arrange.hcentre', 'arrange.spaceX', 'image.crop', 'image.trim', 'image.rotateRight', 'image.rotateLeft',
  'image.flipH', 'image.flipV', 'image.flatten', 'image.rasterizeLayer', 'image.newLayer', 'image.deleteLayer',
  'image.mergeDown', 'layer.up', 'layer.down', 'adjust.bw', 'adjust.invert', 'adjust.autoLevel', 'view.zoomIn',
  'view.zoomOut', 'view.fit', 'view.grid', 'view.snapping', 'edit.sizeUp', 'edit.sizeDown',
];
const TOOLS = [
  'select-rect', 'select-free', 'magic-wand', 'pencil', 'brush', 'eraser', 'fill', 'picker', 'rectangle', 'ellipse', 'polygon',
  'star', 'arrow', 'line', 'highlight', 'blur', 'pixelate', 'marker', 'spotlight',
];

/** Checks the document is consistent; returns a problem, or null. */
const VALIDATE = `(() => {
  const { app } = window.sketch;
  const d = app.doc;
  if (!(d.width >= 1 && d.height >= 1 && d.width <= 16384 && d.height <= 16384)) return 'bad size ' + d.width + 'x' + d.height;
  if (!d.layers.length) return 'no layers';
  if (d.active < 0 || d.active >= d.layers.length) return 'current layer ' + d.active + ' of ' + d.layers.length;
  if (!d.layers.some((l) => l.kind === 'pixel')) return 'no pixel layer';
  for (const l of d.layers) {
    if (l.kind === 'pixel' && (l.canvas.width !== d.width || l.canvas.height !== d.height)) return 'layer ' + l.name + ' is ' + l.canvas.width + 'x' + l.canvas.height;
    if (l.kind === 'objects' && !Array.isArray(l.objects)) return 'layer ' + l.name + ' has no object list';
    if (!(l.opacity >= 0 && l.opacity <= 1)) return 'layer opacity ' + l.opacity;
  }
  if (app.history.position < 0) return 'history position ' + app.history.position;
  return null;
})()`;

const summary = `(() => { const d = window.sketch.app.doc; return d.width + 'x' + d.height + ' ' + d.layers.map((l) => l.kind + (l.kind === 'objects' ? l.objects.length : '')).join(','); })()`;

let app;
let steps = 0;
let failure = null;
console.log(`Random edits for ${minutes} min, seed ${seed}`);
try {
  app = await launch(exe, work);
  await app.evaluate(`window.sketch.app.history.cap = 256 * 1024 * 1024`); // Steps stay undoable for the final check.
  const start = await app.evaluate(summary);
  const b = app.canvasBox;
  const point = () => [b.x + b.w * (0.15 + random() * 0.7), b.y + b.h * (0.15 + random() * 0.7)];
  const end = Date.now() + minutes * 60_000;
  let lastReport = Date.now();
  const ctrl = 2;

  while (Date.now() < end) {
    const r = random();
    let what;
    if (r < 0.35) {
      const tool = pick(TOOLS);
      const [x1, y1] = point();
      const [x2, y2] = random() < 0.2 ? [x1, y1] : point();
      what = `${tool} drag`;
      // Tools in a shared rail slot have a tool command; a tool alone in its slot has the slot's.
      await app.evaluate(`window.sketch.run('tool.${tool}'); window.sketch.run('slot.${tool}')`);
      await app.drag(x1, y1, x2, y2);
    } else if (r < 0.6) {
      what = pick(COMMANDS);
      await app.evaluate(`window.sketch.run('${what}')`);
    } else if (r < 0.75) {
      const n = 1 + Math.floor(random() * 5);
      what = `undo ×${n}`;
      for (let i = 0; i < n; i++) await app.press('z', ctrl);
    } else if (r < 0.85) {
      const n = 1 + Math.floor(random() * 5);
      what = `redo ×${n}`;
      for (let i = 0; i < n; i++) await app.press('y', ctrl);
    } else if (r < 0.92) {
      what = pick(['Enter', 'Escape', 'Delete']);
      await app.press(what);
    } else {
      // Arrow-key nudges of a selection or picked shapes.
      what = 'nudge';
      await app.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', code: 'ArrowRight', bubbles: true }))`);
    }
    steps++;
    // A dialog that opened by chance (a crop that asks, say) is closed.
    const s = await app.state();
    if (s.dialog) await app.press('Escape');
    const problem = await app.evaluate(VALIDATE);
    const errors = app.logs.filter((l) => l.startsWith('uncaught') || l.startsWith('console.error'));
    if (problem || errors.length) {
      failure = `After step ${steps} (${what}): ${problem ?? errors.join('\n  ')}`;
      break;
    }
    if (Date.now() - lastReport > 60_000) {
      console.log(`  ${steps} steps, ${Math.round((end - Date.now()) / 60000)} min left, picture ${await app.evaluate(summary)}`);
      lastReport = Date.now();
    }
    if (steps % 200 === 0) await sleep(50);
  }

  if (!failure) {
    // Undo everything: the picture must be back where it started. Then redo it all.
    await app.evaluate(`(() => { const { app } = window.sketch; app.selection = null; app.textEdit = null; app.objectSel = null; })()`);
    const done = await app.evaluate(summary);
    const top = await app.evaluate(`window.sketch.app.history.position`);
    await app.evaluate(`window.sketch.app.history.jumpTo(0)`);
    const back = await app.evaluate(summary);
    const evicted = await app.evaluate(`window.sketch.app.history.entries()[0].position === null`);
    if (!evicted && back !== start) failure = `Undoing everything gave ${back}, not ${start}`;
    await app.evaluate(`window.sketch.app.history.jumpTo(${top})`);
    const again = await app.evaluate(summary);
    if (!failure && again !== done) failure = `Redoing everything gave ${again}, not ${done}`;
    const problem = await app.evaluate(VALIDATE);
    if (!failure && problem) failure = `After undoing and redoing everything: ${problem}`;
  }
} catch (e) {
  failure = `After step ${steps}: ${e.message}`;
} finally {
  await app?.quit();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
}

if (failure) {
  console.log(`FAIL  ${failure}\n      Replay with SKETCH_FUZZ_SEED=${seed}`);
  process.exit(1);
}
console.log(`PASS  ${steps} random steps in ${minutes} min with no errors, and undo and redo all the way back and forth`);
