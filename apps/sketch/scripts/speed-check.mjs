// Times the main flows in the built app against the speed goals: pasting a 4K screenshot under
// 200 ms, brush strokes on a 4K picture at 60 frames a second, and how long copying, saving,
// mark-up and autosave take on a 4K picture (reported, with loose limits so a big slowdown fails).
// Start-up has its own check (startup-check.mjs).
// Usage: node scripts/speed-check.mjs [path-to-exe]
//
// Drives the page through WebView2's debugging port like native-check.mjs, with its own data folder.
// It replaces whatever is on the clipboard. Windows only.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clipboard, launch, png, sleep } from './native-driver.mjs';

const exe = resolve(process.argv[2] ?? join('src-tauri', 'target', 'release', 'sketch.exe'));
if (!existsSync(exe)) {
  console.error(`App not found at ${exe}. Build it first with: npm run tauri build`);
  process.exit(1);
}
const work = mkdtempSync(join(tmpdir(), 'sketch-speed-'));
const shot = join(work, 'screenshot-4k.png');
writeFileSync(shot, png(3840, 2160));

const results = [];
function report(name, value, unit, limit) {
  const ok = limit === undefined || value <= limit;
  results.push({ name, ok });
  const lim = limit === undefined ? '' : ` (limit ${limit} ${unit})`;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${value.toFixed(unit === 'fps' ? 1 : 0)} ${unit}${lim}`);
}

/** Runs `start` in the page, then waits for `done` to be true after a frame; returns the milliseconds between. */
const timeInPage = (app, done) =>
  app.evaluate(`(() => {
    window.__timing = new Promise((resolve) => {
      const t0 = performance.now();
      const poll = () => ((${done})() ? requestAnimationFrame(() => resolve(performance.now() - t0)) : setTimeout(poll, 1));
      poll();
    });
    return true;
  })()`);

let app;
try {
  app = await launch(exe, work);
  const ctrl = 2;
  const shift = 8;
  const b = app.canvasBox;

  // ---------- Paste a 4K screenshot ----------
  const pasteTimes = [];
  for (let i = 0; i < 3; i++) {
    clipboard.image(shot);
    // Timed from the key press until the pasted picture is on screen.
    await app.evaluate(`window.__keyAt = new Promise((r) => addEventListener('keydown', () => r(performance.now()), { capture: true, once: true })); true`);
    // The first paste makes the new picture 4K; the next ones float over it.
    const sel = i === 0 ? `() => document.querySelector('.st-size')?.textContent === '3840 × 2160 px'` : `() => (document.querySelector('.st-selection')?.textContent ?? '').startsWith('3840')`;
    await app.evaluate(`window.__seen = new Promise((resolve) => {
      const poll = () => ((${sel})() ? requestAnimationFrame(() => resolve(performance.now())) : setTimeout(poll, 1));
      poll();
    }); true`);
    await app.press('v', ctrl, ['paste']);
    const ms = await app.evaluate(`Promise.all([window.__keyAt, window.__seen]).then(([a, b]) => b - a)`);
    pasteTimes.push(ms);
    await app.press(i === 0 ? 'Enter' : 'Escape');
    await sleep(500);
  }
  report('Paste a 4K screenshot into a new picture', pasteTimes[0], 'ms', 200);
  report('Paste a 4K screenshot onto a 4K picture (slower of 2)', Math.max(pasteTimes[1], pasteTimes[2]), 'ms', 200);

  // ---------- Brush strokes on the 4K picture ----------
  await app.press('b');
  await sleep(200);
  await app.evaluate(`(() => {
    window.__frames = [];
    let last = performance.now();
    window.__rec = true;
    const tick = (t) => { if (!window.__rec) return; window.__frames.push(t - last); last = t; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    return true;
  })()`);
  const x0 = b.x + b.w * 0.2;
  const y0 = b.y + b.h * 0.3;
  await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', buttons: 1, clickCount: 1 });
  const strokeStart = Date.now();
  for (let i = 0; Date.now() - strokeStart < 2000; i++) {
    const t = i / 40;
    await app.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (i * 3) % (b.w * 0.6), y: y0 + Math.sin(t * 6) * b.h * 0.2, button: 'left', buttons: 1 });
    await sleep(4);
  }
  await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x0, y: y0, button: 'left', buttons: 0, clickCount: 1 });
  const frames = await app.evaluate(`(() => { window.__rec = false; return window.__frames.slice(2); })()`);
  const total = frames.reduce((a, f) => a + f, 0);
  const sorted = [...frames].sort((a, c) => a - c);
  report('Brush strokes on a 4K picture', (frames.length / total) * 1000, 'fps');
  results.at(-1).ok = (frames.length / total) * 1000 >= 55;
  if (!results.at(-1).ok) console.log('      (needs at least 55 fps)');
  report('Slowest 5% of brush frames', sorted[Math.floor(sorted.length * 0.95)], 'ms', 33);

  // ---------- Mark-up, copy, save, autosave ----------
  await app.evaluate(`window.sketch.run('tool.marker')`);
  await sleep(100);
  await timeInPage(app, `() => window.sketch.app.history.undoLabel?.toLowerCase().includes('marker')`);
  await app.drag(b.x + b.w / 2, b.y + b.h / 2, b.x + b.w / 2, b.y + b.h / 2);
  report('Place a numbered marker', await app.evaluate('window.__timing'), 'ms', 100);

  await timeInPage(app, `() => (document.querySelector('.toast')?.textContent ?? '').startsWith('Copied the picture')`);
  await app.press('c', ctrl | shift);
  report('Copy the whole 4K picture', await app.evaluate('window.__timing'), 'ms', 1500);

  // Long tasks (main thread busy over 50 ms) while autosave writes the 4K picture.
  await app.evaluate(`(() => {
    window.__long = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__long.push(e.duration); }).observe({ entryTypes: ['longtask'] });
    return true;
  })()`);
  await sleep(5000);
  const longest = await app.evaluate('Math.max(0, ...window.__long)');
  report('Longest pause while autosave writes the 4K picture', longest, 'ms', 100);
} finally {
  await app?.quit();
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} timings within their limits.`);
if (failed) process.exit(1);
