// Drives the built app to check the parts that only work in the real window:
// clipboard paste (bitmap, Explorer file, image link), copy with transparency, copying and pasting shapes,
// the native Open and Save dialogs, Ctrl+S, drag and drop, "Open with" and the close prompt, tabs,
// plus the app shell: Mica, menu Paste, tool shortcuts, the screen colour picker and settings
// that survive a restart, Remove Background with its add-on download, the mouse speed slider,
// screen capture with the capture helper (sketch-capture.exe) that keeps it ready while Sketch is
// closed, and the Copy button.
// Usage: node scripts/native-check.mjs [path-to-exe]
//
// It talks to the page through WebView2's debugging port (127.0.0.1 only) and fills the
// file dialogs with window messages, so it never moves the mouse or takes the keyboard.
// It does replace whatever is on the clipboard. Windows only.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { attach, captureTarget, clipboard, fillFileDialog, helper, holdHotkey, keys, launch, notesInCentre, overlay, png, pngSize, postClose, ps, screen, sleep } from './native-driver.mjs';

const exe = resolve(process.argv[2] ?? join('src-tauri', 'target', 'release', 'sketch.exe'));
const work = mkdtempSync(join(tmpdir(), 'sketch-native-'));

if (!existsSync(exe)) {
  console.error(`App not found at ${exe}. Build it first with: npm run tauri build`);
  process.exit(1);
}

// ---------- Test pictures ----------

const small = join(work, 'small.png');
const big = join(work, 'big.png');
const linked = join(work, 'linked.png');
const dropped = join(work, 'dropped.png');
writeFileSync(small, png(300, 200));
writeFileSync(big, png(2000, 1500));
writeFileSync(linked, png(64, 48));
writeFileSync(dropped, png(120, 90));
// For Remove Background: an orange ball on a sky-to-grass backdrop, 1080p.
const subject = join(work, 'subject.png');
writeFileSync(
  subject,
  png(1920, 1080, (x, y) => {
    const d = Math.hypot(x - 960, y - 540);
    if (d < 300) {
      const light = 1 - 0.35 * Math.hypot(x - 860, y - 440) / 400;
      return [Math.round(240 * light), Math.round(130 * light), Math.round(30 * light), 255];
    }
    const t = y / 1080;
    return [Math.round(150 - 90 * t), Math.round(200 - 10 * t), Math.round(240 - 190 * t), 255];
  }),
);

// The Remove Background add-on (ONNX Runtime and the model, 193 MB) is served by the test server,
// from SKETCH_TEST_CUTOUT_FILES or the installed Sketch's own copy, so the app downloads and checks it
// as it would from GitHub. With neither, the Remove Background checks are skipped.
const cutoutFiles = [process.env.SKETCH_TEST_CUTOUT_FILES, join(process.env.LOCALAPPDATA ?? '', 'app.sketch.desktop', 'cutout')].find(
  (d) => d && existsSync(join(d, 'u2net.onnx')) && existsSync(join(d, 'onnxruntime.dll')),
);

// ---------- The checks ----------

const results = [];
/** Each check gets this long, so a hang (a dialog nobody answers, a page that stopped replying) fails instead of stalling. */
const CHECK_MS = 60000;

async function check(name, fn) {
  app?.logs.splice(0);
  try {
    let timer;
    await Promise.race([fn(), new Promise((_, j) => (timer = setTimeout(() => j(new Error(`No result after ${CHECK_MS / 1000} s`)), CHECK_MS)))]);
    clearTimeout(timer);
    results.push({ name, ok: true });
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    const logs = app?.logs.splice(0) ?? [];
    if (logs.length) console.log(`      Page console:\n        ${logs.join('\n        ')}`);
  }
}

function expect(cond, message) {
  if (!cond) throw new Error(message);
}

const server = createServer((req, res) => {
  const addOn = /^\/cutout\/(onnxruntime\.dll|u2net\.onnx)$/.exec(req.url ?? '');
  if (req.url === '/linked.png') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end(readFileSync(linked));
  } else if (addOn && cutoutFiles) {
    const file = join(cutoutFiles, addOn[1]);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': statSync(file).size });
    createReadStream(file).pipe(res);
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const serverPort = server.address().port;

let app;
try {
  app = await launch(exe, work);
  const { press, waitFor, state } = app;
  const ctrl = 2;
  const shift = 8;
  const paste = () => press('v', ctrl, ['paste']);

  await check('Pasting a copied bitmap into a new picture makes the picture that size', async () => {
    clipboard.image(small);
    await paste();
    await waitFor('a 300 × 200 picture', (s) => s.size === '300 × 200 px');
  });

  await check('Pasting a picture file copied in Explorer grows the canvas to fit', async () => {
    clipboard.files(big);
    await paste();
    const s = await waitFor('the canvas to grow', (s) => s.size === '2000 × 1500 px');
    expect(s.floating === '2000 × 1500 px', `Expected a floating paste, got "${s.floating}"`);
    await press('Enter');
    await waitFor('the paste to be placed', (s) => s.floating === '');
  });

  await check('Pasting an image link downloads and pastes the image', async () => {
    clipboard.text(`http://127.0.0.1:${serverPort}/linked.png`);
    await paste();
    await waitFor('the linked image', (s) => s.floating === '64 × 48 px');
    await press('Escape');
    await waitFor('the paste to be cancelled', (s) => s.floating === '');
  });

  await check('Paste in the Edit menu reads the clipboard picture without a paste event', async () => {
    clipboard.image(small);
    await app.evaluate(`[...document.querySelectorAll('.menu-title')].find((b) => b.textContent === 'Edit').click()`);
    await sleep(200);
    await app.evaluate(`document.querySelector('[data-command="edit.paste"]').click()`);
    await waitFor('the pasted picture', (s) => s.floating === '300 × 200 px');
    await press('Escape');
    await waitFor('the paste to be cancelled', (s) => s.floating === '');
  });

  await check('The window has the Windows 11 Mica background', async () => {
    expect(await app.evaluate(`document.documentElement.classList.contains('mica')`), 'The page did not get the mica class');
    const bg = await app.evaluate(`getComputedStyle(document.body).backgroundColor`);
    expect(bg === 'rgba(0, 0, 0, 0)', `The page background is ${bg}, so Mica can't show through`);
  });

  await check('Colour theme in Settings turns the page and the window light or dark, and back to Windows', async () => {
    // The WebView's prefers-color-scheme follows the window's theme, so it shows the window was told too.
    const look = `({ page: document.documentElement.classList.contains('dark'), window: matchMedia('(prefers-color-scheme: dark)').matches, saved: localStorage.getItem('sketch.theme') })`;
    const windows = (await app.evaluate(look)).window;
    await app.press(',', ctrl);
    await sleep(200);
    const pick = async (value) => {
      await app.evaluate(`(() => {
        const box = document.querySelector('[data-setting="theme"]');
        box.value = ${JSON.stringify(value)};
        box.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      const end = Date.now() + 5000;
      let s;
      do {
        await sleep(150);
        s = await app.evaluate(look);
      } while (Date.now() < end && (s.page !== s.window || s.saved !== JSON.stringify(value)));
      return s;
    };
    let s = await pick(windows ? 'light' : 'dark');
    expect(s.page === !windows && s.window === !windows, `After forcing the other theme: ${JSON.stringify(s)}`);
    s = await pick(windows ? 'dark' : 'light');
    expect(s.page === windows && s.window === windows, `After forcing the Windows theme: ${JSON.stringify(s)}`);
    await pick(windows ? 'light' : 'dark');
    s = await pick('system');
    expect(s.page === windows && s.window === windows, `After going back to Same as Windows: ${JSON.stringify(s)}`);
    await press('Escape');
  });

  await check('Tool keys pick tools, and the screen colour picker is available', async () => {
    await press('g');
    await waitFor('the Fill tool', (s) => s.tool === 'Fill');
    await press('b');
    await waitFor('the Brush tool', (s) => s.tool === 'Brush');
    expect(await app.evaluate(`'EyeDropper' in window`), 'WebView2 has no EyeDropper, so the popover hides its screen picker');
  });

  await check('Ctrl+Shift+C puts a PNG of the whole picture on the clipboard', async () => {
    clipboard.text('nothing yet');
    await press('c', ctrl | shift);
    await waitFor('the copy', (s) => (s.toast ?? '').startsWith('Copied the picture'));
    const formats = clipboard.formats();
    expect(formats.includes('PNG'), `Clipboard formats: ${formats.join(', ')}`);
    const size = clipboard.pngSize();
    expect(size.w === 2000 && size.h === 1500, `Clipboard PNG is ${size.w} × ${size.h}`);
  });

  const saved = join(work, 'saved.png');
  await check('Save As writes the file chosen in the native Save dialog', async () => {
    await press('s', ctrl | shift);
    await waitFor('the Save As box', (s) => s.dialog === 'Save As');
    await press('Enter');
    fillFileDialog(app.pid, saved);
    await waitFor('the save', (s) => s.title === 'saved.png - Sketch');
    expect(existsSync(saved), `Nothing was written to ${saved}`);
    const size = pngSize(readFileSync(saved));
    expect(size.w === 2000 && size.h === 1500, `Saved PNG is ${size.w} × ${size.h}`);
    expect(!existsSync(saved + '.sktch-tmp'), 'The temporary file was left behind');
  });

  await check('Ctrl+S after a change saves to the same file without asking', async () => {
    const before = statSync(saved).mtimeMs;
    const b = app.canvasBox;
    await app.drag(b.x + b.w / 2, b.y + b.h / 2, b.x + b.w / 2 + 80, b.y + b.h / 2 + 40);
    await waitFor('the picture to be marked changed', (s) => s.title === 'saved.png* - Sketch');
    await press('s', ctrl);
    await waitFor('the save', (s) => s.title === 'saved.png - Sketch');
    expect(statSync(saved).mtimeMs > before, 'The file was not rewritten');
  });

  await check('Fill runs in its worker in the built app, and undoes', async () => {
    await press('g');
    await waitFor('the Fill tool', (s) => s.tool === 'Fill');
    // Just above where the last check's brush stroke starts, which is on the picture whatever the zoom.
    const b = app.canvasBox;
    const x = b.x + b.w / 2 + 20;
    const y = b.y + b.h / 2 - 30;
    await app.drag(x, y, x, y);
    await waitFor('the fill', (s) => s.title === 'saved.png* - Sketch');
    const steps = await app.evaluate(`[...document.querySelectorAll('.history button')].map((b) => b.textContent)`);
    expect(steps.includes('Fill'), `History: ${steps.join(', ')}`);
    await press('z', ctrl);
    await waitFor('the fill to be undone', (s) => s.title === 'saved.png - Sketch');
  });

  await check('Open reads the file chosen in the native Open dialog', async () => {
    await press('o', ctrl);
    fillFileDialog(app.pid, small);
    await waitFor('small.png to open', (s) => s.title === 'small.png - Sketch' && s.size === '300 × 200 px');
  });

  await check('Shapes copied with Ctrl+C paste back as shapes, and a newer clipboard picture still pastes as a picture', async () => {
    const history = () => app.evaluate(`[...document.querySelectorAll('.history button')].map((b) => b.textContent)`);
    await press('u');
    await waitFor('the Rectangle tool', (s) => s.tool === 'Rectangle');
    const b = app.canvasBox;
    await app.drag(b.x + b.w / 2 - 60, b.y + b.h / 2 - 40, b.x + b.w / 2 + 60, b.y + b.h / 2 + 40);
    await sleep(200);
    expect((await history()).includes('Add rectangle'), `History: ${(await history()).join(', ')}`);
    clipboard.text('nothing yet');
    await press('c', ctrl);
    await waitFor('the copy', (s) => s.toast === 'Copied the shape');
    const formats = clipboard.formats();
    expect(formats.includes('PNG'), `Clipboard formats: ${formats.join(', ')}`);
    await paste();
    await waitFor('the pasted shape', (s) => s.toast === 'Pasted the rectangle');
    clipboard.image(small);
    await paste();
    await waitFor('the pasted picture', (s) => s.floating === '300 × 200 px');
    await press('Escape');
    await waitFor('the paste to be cancelled', (s) => s.floating === '');
    await press('b');
    await waitFor('the Brush tool', (s) => s.tool === 'Brush');
    expect((await history()).includes('Paste rectangle'), `History: ${(await history()).join(', ')}`);
  });

  // Windows hands the drop to Tauri, which sends this event to the page. The check sends the
  // same event, with the position in physical pixels as Tauri does, so it covers everything
  // after Windows: the position maths, reading the file from Rust, and adding or opening it.
  const dropAt = (path, cssX, cssY) =>
    app.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit_to', {
      target: { kind: 'Webview', label: 'main' },
      event: 'tauri://drag-drop',
      payload: { paths: [${JSON.stringify(path)}], position: { x: ${cssX * app.dpr}, y: ${cssY * app.dpr} } },
    })`);

  await check('Dropping a picture file on the picture adds it as a new layer', async () => {
    const b = app.canvasBox;
    await dropAt(dropped, b.x + b.w / 2, b.y + b.h / 2);
    await waitFor('the new layer', (s) => s.toast === 'Added dropped.png as a new layer' && s.title === 'small.png* - Sketch');
  });

  await check('Dropping a picture file beside the picture opens it in a new tab, which shows the tab strip', async () => {
    const b = app.canvasBox;
    const before = (await app.state()).tabs;
    await dropAt(big, b.x + 10, b.y + 10);
    await waitFor('big.png to open', (s) => s.title === 'big.png - Sketch' && s.size === '2000 × 1500 px' && s.tabs === before + 1);
    const names = await app.evaluate(`[...document.querySelectorAll('.tab')].map((t) => t.textContent + (t.classList.contains('dirty') ? ' (unsaved)' : '')).join(', ')`);
    expect(names.endsWith('small.png (unsaved), big.png'), `Tabs: ${names}`);
  });

  await check("Closing the window with unsaved changes asks Save or Don't Save, and clicking outside the box keeps it open", async () => {
    const b = app.canvasBox;
    await app.drag(b.x + b.w / 2, b.y + b.h / 2, b.x + b.w / 2 + 50, b.y + b.h / 2);
    await waitFor('the picture to be marked changed', (s) => s.title === 'big.png* - Sketch');
    postClose(app.pid);
    await waitFor('the unsaved changes box', (s) => s.dialog === 'Save your changes?');
    const buttons = await app.evaluate(`[...document.querySelectorAll('.dialog button')].map((b) => b.textContent).join(', ')`);
    expect(buttons === "Don't Save, Save", `Buttons: ${buttons}`);
    // A click on the dimmed window outside the box.
    const out = { x: 5, y: b.y + b.h - 5, button: 'left', clickCount: 1 };
    await app.send('Input.dispatchMouseEvent', { type: 'mousePressed', buttons: 1, ...out });
    await app.send('Input.dispatchMouseEvent', { type: 'mouseReleased', buttons: 0, ...out });
    await waitFor('the box to close', (s) => s.dialog === null);
    await sleep(500);
    expect(app.child.exitCode === null, 'The app closed anyway');
  });

  await check("Closing again asks about each tab with changes, and choosing Don't Save for both closes the app", async () => {
    postClose(app.pid);
    await waitFor('the first tab to ask', (s) => s.dialog === 'Save your changes?' && s.title === 'small.png* - Sketch');
    await app.clickButton("Don't Save");
    await waitFor('the second tab to ask', (s) => s.dialog === 'Save your changes?' && s.title === 'big.png* - Sketch');
    await app.clickButton("Don't Save").catch(() => {}); // The page may go away before it answers.
    expect(await app.quit(5000), "The app didn't close");
  });
  await app.quit();

  await check('Opening a file with the app ("Open with") shows that file', async () => {
    app = await launch(exe, work, [small]);
    await app.waitFor('small.png', (s) => s.title === 'small.png - Sketch' && s.size === '300 × 200 px');
  });

  await check('Closing with no unsaved changes closes straight away', async () => {
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
  });

  await check('Tool settings, the colour theme and changed shortcuts survive closing and reopening the app, which starts with the black brush', async () => {
    app = await launch(exe, work, [], 'keep');
    // Type a brush size, pick Dark, give Swap Colours a new key in Settings, pick the pencil, then close right away.
    await app.evaluate(`(() => {
      const box = document.querySelector('.opt.range .num');
      box.value = '37';
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    // A new launch, so its own press (the one from the first launch talks to a closed window).
    await app.press(',', ctrl);
    await sleep(200);
    await app.evaluate(`(() => {
      const box = document.querySelector('[data-setting="theme"]');
      box.value = 'dark';
      box.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await app.evaluate(`document.querySelector('[data-command="edit.swapColors"] .key-btn').click()`);
    await sleep(100);
    await app.press('q');
    await sleep(100);
    await app.press('Escape');
    await app.press('p');
    await app.waitFor('the pencil', (s) => s.tool === 'Pencil');
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
    app = await launch(exe, work, [], 'keep');
    const tool = (await app.state()).tool;
    expect(tool === 'Brush', `Tool after reopening: ${tool}`);
    const color = await app.evaluate('window.sketch.app.primary');
    expect(color === '#000000', `Colour 1 after reopening: ${color}`);
    const size = await app.evaluate(`document.querySelector('.opt.range .num').value`);
    expect(size === '37', `Brush size after reopening is ${size}`);
    const dark = await app.evaluate(`document.documentElement.classList.contains('dark')`);
    expect(dark === true, "The page isn't dark after reopening with Dark picked");
    const keys = await app.evaluate(`localStorage.getItem('sketch.keys')`);
    expect(keys === '{"edit.swapColors":["Q"]}', `Saved shortcuts after reopening: ${keys}`);
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
  });

  // ---------- Autosave, recovery and more than one window ----------

  // Each part gets its own data folder, so leftovers from one never reopen in another.
  const dataFor = (name) => {
    const dir = join(work, `data-${name}`);
    mkdirSync(dir, { recursive: true });
    // Capture notifications go after 3 seconds (F12); checks hold them for a minute, so a slow step
    // before a click doesn't lose one. The checks of the 3 seconds take this file out.
    writeFileSync(join(dir, 'note-ms.txt'), '60000');
    return { dir, env: { SKETCH_DATA_DIR: dir } };
  };
  const slots = (dir, ext) => {
    try {
      return readdirSync(join(dir, 'recovery')).filter((f) => f.endsWith(ext));
    } catch {
      return [];
    }
  };
  const waitUntil = async (what, test, ms = 10000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await test()) return;
      await sleep(150);
    }
    throw new Error(`Timed out waiting for ${what}`);
  };

  const crash = dataFor('crash');
  await check('Autosave keeps an unsaved picture, and it comes back after a crash', async () => {
    app = await launch(exe, work, [], null, crash.env);
    clipboard.image(small);
    await app.press('v', ctrl, ['paste']);
    await app.waitFor('the pasted picture', (s) => s.size === '300 × 200 px' && s.title === 'Untitled* - Sketch');
    await waitUntil('the autosave', () => slots(crash.dir, '.sktch').length === 1, 8000);
    app.child.kill(); // Like a crash: no close, no clean-up.
    await app.quit();
    app = await launch(exe, work, [], null, crash.env);
    const s = await app.waitFor('the picture to come back', (s) => s.title === 'Untitled* - Sketch' && s.size === '300 × 200 px');
    expect((s.toast ?? '').startsWith('Brought back Untitled'), `Toast: ${s.toast}`);
    expect(slots(crash.dir, '.json').length === 1, `Slots after recovery: ${slots(crash.dir, '.json').join(', ')}`);
  });

  await check("Closing with Don't Save removes the autosave", async () => {
    postClose(app.pid);
    await app.waitFor('the unsaved changes box', (s) => s.dialog === 'Save your changes?');
    await app.clickButton("Don't Save").catch(() => {});
    expect(await app.quit(5000), "The app didn't close");
    expect(slots(crash.dir, '.json').length === 0, `Slots left: ${slots(crash.dir, '.json').join(', ')}`);
    app = await launch(exe, work, [], null, crash.env);
    await app.waitFor('a new picture', (s) => s.title === 'Untitled - Sketch');
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
  });

  // ---------- Tabs (F14) ----------

  const tabData = dataFor('tabs');
  /** The tabs' names as the strip shows them, with the one showing in brackets. */
  const tabNames = () =>
    app.evaluate(`[...document.querySelectorAll('.tab')].map((t) => (t.classList.contains('active') ? '[' + t.querySelector('.tab-name').textContent + ']' : t.querySelector('.tab-name').textContent)).join(', ')`);
  const mouse = (type, x, y, buttons) => app.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 });
  const centreOf = (sel) => app.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`);

  await check('Ctrl+Tab, Ctrl+Shift+Tab and clicking a tab switch pictures, each with its own undo', async () => {
    app = await launch(exe, work, [], null, tabData.env);
    clipboard.image(small);
    await app.press('v', ctrl, ['paste']);
    await app.waitFor('the pasted picture', (s) => s.size === '300 × 200 px');
    // Dropped beside the picture, a file opens in a new tab; a whiteboard then opens between them.
    const box = () => app.evaluate(`(() => { const r = document.querySelector('canvas.view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    let b = await box();
    await dropAt(dropped, b.x + 5, b.y + b.h - 5);
    await app.waitFor('dropped.png in a second tab', (s) => s.tabs === 2 && s.title === 'dropped.png - Sketch');
    await app.press('Tab', ctrl | shift);
    await app.waitFor('Ctrl+Shift+Tab to go back', (s) => s.size === '300 × 200 px');
    await app.evaluate(`window.sketch.run('file.newBoard')`);
    await app.waitFor('a whiteboard in a third tab', (s) => s.tabs === 3 && s.size === 'Whiteboard');
    b = await box();
    await app.drag(b.x + b.w / 2 - 40, b.y + b.h / 2, b.x + b.w / 2 + 40, b.y + b.h / 2 + 20);
    await app.waitFor('a stroke on the whiteboard', (s) => s.title === 'Untitled* - Sketch' && s.size === 'Whiteboard');
    expect((await tabNames()) === 'Untitled, [Whiteboard], dropped.png', `Tabs: ${await tabNames()}`);
    await app.press('Tab', ctrl);
    await app.waitFor('Ctrl+Tab to go to the next tab', (s) => s.title === 'dropped.png - Sketch');
    await app.press('Tab', ctrl);
    await app.waitFor('Ctrl+Tab to go round to the first tab', (s) => s.size === '300 × 200 px');
    const [x, y] = await centreOf('[data-tab-index="1"]');
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseReleased', x, y, 0);
    await app.waitFor('a click to show the whiteboard', (s) => s.size === 'Whiteboard');
    const undo = await app.evaluate(`window.sketch.tabs.list.map((t) => t.history.undoLabel ?? '-').join(', ')`);
    expect(undo === 'Paste, Brush stroke, -', `Each tab's last step: ${undo}`);
  });

  await check('Moving shapes onto another tab: resting on the tab switches to it, and each picture gets one undo step', async () => {
    await app.evaluate(`window.sketch.run('tool.rectangle')`);
    const b = await app.evaluate(`(() => { const r = document.querySelector('canvas.view').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
    const cx = b.x + b.w / 2;
    const cy = b.y + b.h / 2;
    await app.drag(cx - 60, cy - 40, cx + 60, cy + 40);
    await sleep(200);
    // Press on its top edge (an unfilled shape is picked by its outline), then rest on the first tab.
    await mouse('mousePressed', cx - 30, cy - 40, 1);
    await mouse('mouseMoved', cx - 20, cy - 30, 1);
    const [tx, ty] = await centreOf('[data-tab-index="0"]');
    await mouse('mouseMoved', tx, ty, 1);
    await app.waitFor('the first tab to show', (s) => s.size === '300 × 200 px', 3000);
    await mouse('mouseMoved', cx, cy, 1);
    await mouse('mouseReleased', cx, cy, 0);
    await sleep(200);
    const r = await app.evaluate(`(() => {
      const t = window.sketch.tabs.list;
      const shapes = (i) => t[i].doc.layers.filter((l) => l.kind === 'objects').reduce((n, l) => n + l.objects.length, 0);
      return { here: shapes(0), there: shapes(1), undoHere: t[0].history.undoLabel, undoThere: t[1].history.undoLabel, picked: window.sketch.app.objectSel?.ids.length ?? 0 };
    })()`);
    expect(r.here === 1 && r.there === 0 && r.picked === 1, `Shapes: ${JSON.stringify(r)}`);
    expect(r.undoHere === 'Move rectangle from whiteboard' && r.undoThere === 'Move rectangle to Untitled', `Undo steps: ${JSON.stringify(r)}`);
  });

  await check('Ten open tabs switch in under a frame each', async () => {
    // New tabs open after the one showing, so start from the last.
    await app.evaluate(`window.sketch.run('tab.prev')`);
    await app.waitFor('the last tab', (s) => s.title === 'dropped.png - Sketch');
    clipboard.image(big);
    while ((await app.state()).tabs < 10) {
      const n = (await app.state()).tabs;
      await app.evaluate(`window.sketch.run('file.newBoard')`);
      await app.waitFor('a new tab', (s) => s.tabs === n + 1);
      await app.evaluate(`window.sketch.run('edit.paste')`);
      await app.waitFor('the paste', (s) => s.floating === '2000 × 1500 px');
      await app.press('Enter');
    }
    // One switch a frame: each frame draws the last switch's picture, then switches again. The work
    // a frame holds is the time from its start to the end of the switch.
    const work = await app.evaluate(`new Promise((done) => {
      const out = [];
      let n = 0;
      const step = (ts) => {
        if (n > 0) {
          window.sketch.run('tab.next');
          out.push(performance.now() - ts);
        } else window.sketch.run('tab.next');
        if (++n <= 30) requestAnimationFrame(step);
        else done(out.sort((a, b) => a - b));
      };
      requestAnimationFrame(step);
    })`);
    const median = work[Math.floor(work.length / 2)];
    const worst = work[work.length - 1];
    console.log(`      Switching ten tabs: median ${median.toFixed(1)} ms of work a frame, worst ${worst.toFixed(1)} ms`);
    expect(median < 16.7, `Median work a frame ${median.toFixed(1)} ms`);
  });

  await check('A killed app brings every tab back, in order, with the one that was showing', async () => {
    // Back to three tabs: the pasted picture, the whiteboard and dropped.png.
    while ((await app.state()).tabs > 3) {
      const n = (await app.state()).tabs;
      await app.evaluate(`window.sketch.tabs.list.at(-1).history.markSaved(); window.sketch.tabs.active = window.sketch.tabs.list.length - 1; window.sketch.run('tab.close')`);
      await app.waitFor('the tab to close', (s) => s.tabs === n - 1);
    }
    await app.evaluate(`window.sketch.run('tab.prev')`);
    await app.waitFor('the whiteboard', (s) => s.size === 'Whiteboard');
    // The tab showing is written half a second after a switch, without the picture.
    const showing = () => slots(tabData.dir, '.json').map((f) => JSON.parse(readFileSync(join(tabData.dir, 'recovery', f), 'utf8'))).find((m) => m.active);
    await waitUntil('the autosaves', () => slots(tabData.dir, '.sktch').length === 2 && slots(tabData.dir, '.json').length === 3 && showing()?.order === 1, 10000);
    app.child.kill();
    await app.quit();
    app = await launch(exe, work, [], null, tabData.env);
    await app.waitFor('three tabs back', (s) => s.tabs === 3, 10000);
    const names = await tabNames();
    expect(names === 'Untitled, [Whiteboard], dropped.png', `Tabs after the crash: ${names}`);
    const kinds = await app.evaluate(`window.sketch.tabs.list.map((t) => (t.doc.board ? 'board' : t.doc.width + 'x' + t.doc.height) + (t.history.dirty ? '*' : '')).join(', ')`);
    expect(kinds === '300x200*, board*, 120x90', `Pictures after the crash: ${kinds}`);
    expect((await app.windowTitles()).length === 1, 'The tabs came back in more than one window');
  });

  await check('Dragging a tab out of the window opens it in a window of its own', async () => {
    const [x, y] = await centreOf('[data-tab-index="2"]');
    await mouse('mousePressed', x, y, 1);
    await mouse('mouseMoved', x + 10, y + 10, 1);
    await mouse('mouseMoved', x, y - 200, 1);
    await mouse('mouseReleased', x, y - 200, 0);
    await waitUntil('a second window', async () => (await app.windowTitles()).length === 2);
    await waitUntil('dropped.png in it', async () => (await app.windowTitles()).includes('dropped.png - Sketch'));
    expect((await app.state()).tabs === 2, `Tabs left: ${(await app.state()).tabs}`);
  });

  await check('Closing a tab with changes asks first, and closing the last tab closes the window', async () => {
    await app.press('F4', ctrl);
    await app.waitFor('the unsaved changes box', (s) => s.dialog === 'Save your changes?');
    await app.clickButton("Don't Save");
    await app.waitFor('one tab left', (s) => s.tabs === 1);
    await app.press('F4', ctrl);
    await app.waitFor('the unsaved changes box', (s) => s.dialog === 'Save your changes?');
    await app.clickButton("Don't Save").catch(() => {});
    await waitUntil('the window to close', async () => (await app.windowTitles().catch(() => [])).length === 1);
    expect((await app.windowTitles())[0] === 'dropped.png - Sketch', 'The wrong window closed');
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
    expect(slots(tabData.dir, '.json').length === 0, `Slots left: ${slots(tabData.dir, '.json').join(', ')}`);
  });

  const place = dataFor('place');
  const windowOf = (pid) => Number(screen(work, `[SketchScreen]::Windows(${pid})`).split(',')[0].split(':')[0]);
  const bounds = (h) => screen(work, `[SketchScreen]::Bounds(${h})`);
  await check('The window opens where it was last moved and resized, and maximised if it was', async () => {
    app = await launch(exe, work, [], null, place.env);
    let h = windowOf(app.pid);
    screen(work, `[SketchScreen]::Place(${h}, 140, 110, 900, 640, $false)`);
    await sleep(300);
    const before = bounds(h);
    await waitUntil('window.json', () => existsSync(join(place.dir, 'window.json')));
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
    app = await launch(exe, work, [], null, place.env);
    h = windowOf(app.pid);
    expect(bounds(h) === before, `Bounds after reopening: ${bounds(h)}, before closing: ${before}`);
    screen(work, `[SketchScreen]::Maximize(${h})`);
    await sleep(1000);
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
    app = await launch(exe, work, [], null, place.env);
    h = windowOf(app.pid);
    expect(screen(work, `[SketchScreen]::Zoomed(${h})`) === 'True', "The window isn't maximised after reopening");
    screen(work, `[SketchScreen]::Restore(${h})`);
    await sleep(500);
    expect(bounds(h) === before, `Bounds after restoring: ${bounds(h)}, before maximising: ${before}`);
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
  });

  const multi = dataFor('multi');
  /** Starts Sketch again, as Explorer would, and checks that the copy hands over and exits. */
  const launchAgain = async (args) => {
    const second = spawn(exe, args, { stdio: 'ignore', cwd: work, env: { ...process.env, ...multi.env } });
    const code = await Promise.race([new Promise((r) => second.on('exit', r)), sleep(5000).then(() => 'still running')]);
    if (code === 'still running') second.kill();
    expect(code === 0, `The second Sketch didn't hand over and exit (${code})`);
  };

  await check('Opening a file while Sketch runs opens it in a new tab of the running app', async () => {
    app = await launch(exe, work, [], null, multi.env);
    const b = app.canvasBox;
    await app.drag(b.x + b.w / 2, b.y + b.h / 2, b.x + b.w / 2 + 60, b.y + b.h / 2);
    await app.waitFor('a change', (s) => s.title === 'Untitled* - Sketch');
    await launchAgain([small]);
    await app.waitFor('small.png in a second tab', (s) => s.title === 'small.png - Sketch' && s.tabs === 2);
    const titles = await app.windowTitles();
    expect(titles.length === 1, `Windows: ${titles.join(', ')}`);
  });

  await check('The paste shortcut (--paste) opens a new tab with the clipboard picture', async () => {
    clipboard.image(small);
    await launchAgain(['--paste']);
    await app.waitFor('the pasted picture in a third tab', (s) => s.title === 'Untitled* - Sketch' && s.size === '300 × 200 px' && s.tabs === 3);
    expect((await app.windowTitles()).length === 1, 'A new window opened');
  });

  await check('With "the tab showing" chosen, a file opens in place of its picture after asking about changes', async () => {
    await app.press(',', ctrl);
    await sleep(200);
    await app.evaluate(`(() => {
      const select = document.querySelector('[data-setting="openIn"]');
      select.value = 'here';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await app.press('Escape');
    // The first window must be the one used last.
    await app.evaluate(`window.__TAURI_INTERNALS__.invoke('bring_to_front')`);
    await sleep(300);
    await launchAgain([dropped]);
    await app.waitFor('the unsaved changes box', (s) => s.dialog === 'Save your changes?');
    await app.clickButton("Don't Save");
    await app.waitFor('dropped.png in this tab', (s) => s.title === 'dropped.png - Sketch');
    expect((await app.windowTitles()).length === 1 && (await app.state()).tabs === 3, 'A new window or tab opened');
  });

  await check('About Sketch shows the build', async () => {
    await app.evaluate(`window.sketch.run('help.about')`);
    await app.waitFor('the About box', (s) => s.dialog === 'About Sketch');
    const text = await app.text('.about-build');
    expect(/^Build [0-9a-f]{7}/.test(text ?? ''), `About box says: ${text}`);
    await app.press('Escape');
  });
  await app.quit();

  // ---------- Remove Background (F13) ----------

  if (!cutoutFiles) console.log('SKIP  Remove Background: set SKETCH_TEST_CUTOUT_FILES to a folder with onnxruntime.dll and u2net.onnx');
  else {
    const cutout = dataFor('cutout');
    app = await launch(exe, work, [subject], null, { ...cutout.env, SKETCH_CUTOUT_URL: `http://127.0.0.1:${serverPort}/cutout/` });
    // The flattened picture's see-through-ness at a corner (backdrop) and the middle (the ball), and the layers.
    const picture = () =>
      app.evaluate(`(() => {
        const s = window.sketch;
        const c = s.flatten(s.app.doc);
        const alpha = (x, y) => c.getContext('2d').getImageData(x, y, 1, 1).data[3];
        return { layers: s.app.doc.layers.map((l) => l.name + (l.visible ? '' : ' (hidden)')).join(', '), corner: alpha(20, 20), middle: alpha(960, 540), undo: s.app.history.undoLabel };
      })()`);

    await check('Remove Background offers its download first, then cuts the ball out onto a new layer and hides the original', async () => {
      await app.waitFor('the test picture', (s) => s.title === 'subject.png - Sketch');
      await app.evaluate(`window.sketch.run('adjust.removeBackground')`);
      await app.waitFor('the download box', (s) => s.dialog === 'Download Remove Background?');
      await app.clickButton('Download');
      await app.waitFor('the cut-out', (s) => (s.toast ?? '').startsWith('Background removed'), 45000);
      const p = await picture();
      expect(p.layers === 'Background (hidden), Background cut out' || /\(hidden\), .* cut out$/.test(p.layers), `Layers: ${p.layers}`);
      expect(p.corner < 15 && p.middle > 240, `Corner alpha ${p.corner}, middle alpha ${p.middle}`);
      expect(p.undo === 'Remove background', `Undo step: ${p.undo}`);
      const files = readdirSync(join(cutout.dir, 'cutout')).sort().join(', ');
      expect(files === 'onnxruntime.dll, u2net.onnx', `Add-on folder holds: ${files}`);
    });

    await check('Undo puts the picture back as it was', async () => {
      await app.press('z', ctrl);
      const p = await picture();
      expect(!/hidden|cut out/.test(p.layers) && p.corner === 255, `Layers: ${p.layers}, corner alpha ${p.corner}`);
    });

    await check('Once downloaded, Remove Background asks nothing and cuts out a 1080p picture in under 2 seconds', async () => {
      // The first cut-out's message may still show, so wait for the step itself.
      const took = await app.evaluate(`(async () => {
        const s = window.sketch;
        const started = performance.now();
        s.run('adjust.removeBackground');
        while (s.app.history.undoLabel !== 'Remove background' && !document.querySelector('.dialog') && performance.now() - started < 10000) await new Promise((r) => setTimeout(r, 10));
        return Math.round(performance.now() - started);
      })()`);
      expect(!(await app.state()).dialog, 'A box opened');
      expect((await picture()).corner < 15, 'Nothing was cut out');
      expect(took < 2000, `It took ${took} ms`);
      console.log(`      Cut-out of 1920 x 1080: ${took} ms`);
    });
    await app.quit();
  }

  // ---------- Mouse speed ----------

  // The app changes a stand-in file for Windows' mouse speed (see `launch`), and checks say whether
  // Left Ctrl is down in a focused Sketch window with `mouse_speed_force`, so the real keyboard is
  // never read. Keys and strokes go to the page through the debugging port, with the Rectangle
  // Select tool so strokes change nothing in the picture.
  const mouseFile = join(work, 'mouse-speed.txt');
  const systemSpeed = () => readFileSync(mouseFile, 'utf8').trim();
  const mouseData = dataFor('mouse');
  const savedSpeed = join(mouseData.dir, 'mouse-speed.json');
  const ctrlHeld = (ctrl) => app.evaluate(`window.__TAURI_INTERNALS__.invoke('mouse_speed_force', { ctrl: ${JSON.stringify(ctrl)} })`);
  const ctrlKey = (type, code = 'ControlLeft', autoRepeat = false) =>
    app.send('Input.dispatchKeyEvent', { type, key: 'Control', code, windowsVirtualKeyCode: 17, modifiers: type === 'keyUp' ? 0 : 2, autoRepeat });
  const canvasMouse = (type) => {
    const b = app.canvasBox;
    return app.send('Input.dispatchMouseEvent', { type, x: b.x + b.w / 2, y: b.y + b.h / 2, button: 'left', buttons: type === 'mousePressed' ? 1 : 0, clickCount: 1 });
  };
  const holdCtrl = async () => {
    await ctrlHeld(true);
    await ctrlKey('rawKeyDown');
  };
  const setSlider = (n) =>
    app.evaluate(`(async () => {
      if (!document.querySelector('.mouse-popover')) document.querySelector('.mouse-btn').click();
      const end = performance.now() + 3000;
      while (!document.querySelector('.mouse-popover') && performance.now() < end) await new Promise((r) => setTimeout(r, 20));
      const r = document.querySelector('.mouse-popover input[type=range]');
      if (!r) throw new Error('The mouse speed slider did not open');
      r.value = '${n}';
      r.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 100)); // The popover redraws after the input event.
      return document.querySelector('.mouse-value').textContent;
    })()`);
  const buttonTip = () => app.evaluate(`document.querySelector('.mouse-btn').getAttribute('aria-label')`);

  await check('Drawing without Left Ctrl keeps the own speed', async () => {
    writeFileSync(mouseFile, '10');
    app = await launch(exe, work, [], 'mouse', mouseData.env);
    await app.press('m');
    await ctrlHeld(false);
    const shown = await setSlider(-4);
    expect(shown === '50%', `The slider shows ${shown}`);
    expect((await buttonTip()) === 'Mouse speed with Left Ctrl held: 50%', `Button: ${await buttonTip()}`);
    await canvasMouse('mousePressed');
    await sleep(300);
    expect(systemSpeed() === '10', `Speed during a stroke without Ctrl: ${systemSpeed()}`);
    await canvasMouse('mouseReleased');
  });

  await check('Holding Left Ctrl in Sketch brings in the slider speed, and Right Ctrl does not', async () => {
    // `ctrl` in `mouse_speed_force` stands in for Left Ctrl being down in a focused Sketch window.
    await ctrlHeld(true);
    await ctrlKey('rawKeyDown', 'ControlRight');
    await sleep(300);
    expect(systemSpeed() === '10', `Speed with Right Ctrl held: ${systemSpeed()}`);
    await ctrlKey('keyUp', 'ControlRight');
    await ctrlKey('rawKeyDown');
    await waitUntil('the slower speed', () => systemSpeed() === '6', 3000);
    expect(existsSync(savedSpeed), "The user's own speed wasn't saved before the change");
    // A stroke with Ctrl held keeps the slower speed, and letting go of the button doesn't end it.
    await canvasMouse('mousePressed');
    await canvasMouse('mouseReleased');
    await sleep(300);
    expect(systemSpeed() === '6', `Speed after a stroke with Ctrl held: ${systemSpeed()}`);
    await ctrlKey('keyUp');
    await waitUntil('the own speed back', () => systemSpeed() === '10', 3000);
    expect(!existsSync(savedSpeed), 'The saved speed is still there after putting it back');
    // A repeat counts, as when a window takes focus with Ctrl already down.
    await ctrlKey('rawKeyDown', 'ControlLeft', true);
    await waitUntil('the slower speed', () => systemSpeed() === '6', 3000);
    // Left Ctrl coming up, or Sketch losing focus, ends the hold even when the page never says so.
    await ctrlHeld(false);
    await waitUntil('the own speed back', () => systemSpeed() === '10', 3000);
    await ctrlHeld(true);
    await sleep(300);
    expect(systemSpeed() === '10', `Speed after Ctrl came up without a key-up: ${systemSpeed()}`);
    await ctrlKey('keyUp');
    await ctrlHeld(false);
  });

  await check('Killing Sketch with Left Ctrl held leaves the normal speed after the next start, and the slider is remembered', async () => {
    await setSlider(-2);
    await holdCtrl();
    await waitUntil('the slower speed', () => systemSpeed() === '8', 3000);
    app.child.kill(); // Like a crash: nothing puts the speed back.
    await app.quit();
    expect(systemSpeed() === '8', `Speed after the crash: ${systemSpeed()}`);
    app = await launch(exe, work, [], 'mouse', mouseData.env);
    await app.press('m');
    expect(systemSpeed() === '10', `Speed after the next start: ${systemSpeed()}`);
    expect(!existsSync(savedSpeed), 'The saved speed is still there after the next start');
    expect((await buttonTip()) === 'Mouse speed with Left Ctrl held: 75%', `Button after reopening: ${await buttonTip()}`);
  });

  await check('Reset Mouse Speed and closing Sketch both put the own speed back', async () => {
    await holdCtrl();
    await waitUntil('the slower speed', () => systemSpeed() === '8', 3000);
    await app.evaluate(`window.sketch.run('view.mouseReset')`);
    await waitUntil('the normal speed', () => systemSpeed() === '10', 3000);
    expect(!(await app.evaluate(`document.querySelector('.mouse-btn').classList.contains('changed')`)), 'The button still looks changed after Reset');
    await ctrlKey('keyUp');
    await setSlider(-2);
    await holdCtrl();
    await waitUntil('the slower speed', () => systemSpeed() === '8', 3000);
    postClose(app.pid);
    expect(await app.quit(5000), "The app didn't close");
    expect(systemSpeed() === '10', `Speed after closing: ${systemSpeed()}`);
    expect(!existsSync(savedSpeed), 'The saved speed is still there after closing');
  });

  // ---------- Screen capture ----------

  // The overlay is driven with posted window messages (`overlay` in the driver), so the real mouse
  // and keyboard aren't used, but it covers the screens for a moment each time. A borderless magenta
  // window from another process is the thing to capture.
  const target = { x: 300, y: 200, w: 900, h: 600 };
  const sketchWindows = () =>
    screen(work, `[SketchScreen]::Windows(${app.pid})`)
      .split(',')
      .filter(Boolean)
      .map((s) => ({ h: Number(s.split(':')[0]), visible: s.endsWith(':1') }));
  const notMagenta = () =>
    app.evaluate(`(() => {
      const c = window.sketch.flatten(window.sketch.app.doc);
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      let bad = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 0 || d[i + 2] !== 255) bad++;
      return bad;
    })()`);
  const startCapture = async () => {
    await app.evaluate(`window.sketch.run('file.capture')`);
    return overlay.find(work, app.pid);
  };
  // Acts as if the capture's notification was clicked (`capture_click_note`, test hooks only).
  const clickNote = async () => {
    const clicked = await app.evaluate(`window.__TAURI_INTERNALS__.invoke('capture_click_note')`);
    expect(clicked === true, 'No capture notification was showing');
  };
  const clipWidth = () => {
    try {
      return clipboard.pngSize().w;
    } catch {
      return 0;
    }
  };
  const capData = dataFor('capture');
  const coldData = dataFor('cold');
  const magenta = await captureTarget(work, target.x, target.y, target.w, target.h);
  const quickCapture = () => app.evaluate('window.sketch.app.quickCapture');
  /** Tabs holding a screen capture, which opens in a new tab of the window used last (F14). */
  const captureTabs = () => app.evaluate('window.sketch.tabs.list.filter((t) => t.doc.edges).length');
  const setHide = (hide) => app.evaluate(`window.__TAURI_INTERNALS__.invoke('capture_options_set', { after: null, hide: ${hide} })`);
  try {
    await check('"Hide Sketch when capturing" is off after an update, and turning it on in Settings saves it', async () => {
      // Capture settings saved before the switch existed.
      writeFileSync(join(capData.dir, 'capture.json'), JSON.stringify({ keys: null, after: 'notify' }));
      app = await launch(exe, work, [], null, capData.env);
      const options = await app.evaluate(`window.__TAURI_INTERNALS__.invoke('capture_options')`);
      expect(options.hide === false, `capture_options says hide is ${options.hide}`);
      await app.press(',', ctrl);
      const box = `document.querySelector('[data-setting="captureHide"]')`;
      await waitUntil('the switch in Settings', async () => app.evaluate(`!!${box}`), 5000);
      expect((await app.evaluate(`${box}.checked`)) === false, 'The switch shows on');
      await app.evaluate(`${box}.click()`);
      await waitUntil('the switch to be saved', async () => JSON.parse(readFileSync(join(capData.dir, 'capture.json'), 'utf8')).hide === true, 5000);
      await app.press('Escape');
    });

    await check('"Press Left Shift to open the capture" is on for settings from before, saves when turned off, and shows only while captures show a notification', async () => {
      const saved = () => JSON.parse(readFileSync(join(capData.dir, 'capture.json'), 'utf8'));
      await app.press(',', ctrl);
      const box = `document.querySelector('[data-setting="captureShiftOpen"]')`;
      try {
        await waitUntil('the switch in Settings', async () => app.evaluate(`!!${box}`), 5000);
        expect((await app.evaluate(`${box}.checked`)) === true, 'The switch shows off');
        await app.evaluate(`${box}.click()`);
        await waitUntil('the switch to be saved', async () => saved().shift_open === false, 5000);
        await app.evaluate(`(() => { const s = document.querySelector('[data-setting="captureAfter"]'); s.value = 'open'; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
        await waitUntil('the switch to go with "Open it in Sketch"', async () => !(await app.evaluate(`!!${box}`)), 3000);
      } finally {
        await app.evaluate(`window.__TAURI_INTERNALS__.invoke('capture_options_set', { after: 'notify', shiftOpen: true })`);
        await app.press('Escape');
      }
      expect(saved().shift_open === true && saved().after === 'notify', `Settings after the check: ${JSON.stringify(saved())}`);
    });

    await check('With the switch on, Capture Screen hides Sketch, a dragged area goes on the clipboard, and clicking its notification opens it on a canvas its size', async () => {
      // Sketch over the magenta window, so the capture shows whether Sketch hid itself first.
      screen(work, `[SketchScreen]::Place(${sketchWindows()[0].h}, 400, 300, 700, 450, $true)`);
      await sleep(300);
      const before = (await app.state()).size;
      const o = await startCapture();
      expect(!sketchWindows()[0].visible, 'Sketch is still showing while the screen is picked');
      overlay.drag(work, o, 420, 320, 420 + 599, 320 + 399);
      await overlay.gone(work, o);
      await waitUntil('the clipboard', async () => clipWidth() === 600);
      await sleep(500);
      expect((await app.state()).size === before, 'The capture opened before its notification was clicked');
      await clickNote();
      const s = await app.waitFor('the capture', (s) => s.size === '600 × 400 px');
      expect(s.tool === 'Brush', `Tool after capturing: ${s.tool}`);
      const color = await app.evaluate('window.sketch.app.primary');
      expect(color === '#ed1c24', `Colour 1 after capturing: ${color}`);
      expect((s.toast ?? '').startsWith('Captured 600 × 400'), `Toast: ${s.toast}`);
      const bad = await notMagenta();
      expect(bad === 0, `${bad} pixels of the capture aren't the magenta window under Sketch`);
      const size = clipboard.pngSize();
      expect(size.w === 600 && size.h === 400, `Clipboard PNG is ${size.w} × ${size.h}`);
      expect(sketchWindows().every((w) => w.visible), 'Sketch did not come back');
      expect((await quickCapture()) === true, "The capture from Sketch's own notification would still ask before closing");
    });

    await check('With the switch off, Capture Screen leaves Sketch showing, so it is in the capture', async () => {
      await setHide(false);
      clipboard.text('nothing yet');
      const o = await startCapture();
      expect(sketchWindows()[0].visible, 'Sketch hid while the screen was picked');
      // The same area as above, which Sketch's window covers.
      overlay.drag(work, o, 420, 320, 420 + 599, 320 + 399);
      await overlay.gone(work, o);
      await waitUntil('the clipboard', async () => clipWidth() === 600);
      const shown = await app.evaluate(`(async () => {
        const raw = new Uint8Array(await window.__TAURI_INTERNALS__.invoke('read_clipboard_image'));
        let n = 0;
        for (let i = 8; i < raw.length; i += 4) if (raw[i] !== 255 || raw[i + 1] !== 0 || raw[i + 2] !== 255) n++;
        return n / ((raw.length - 8) / 4);
      })()`);
      expect(shown > 0.9, `Only ${(shown * 100).toFixed(0)}% of the capture is Sketch rather than the magenta window behind it`);
      await setHide(true);
    });

    // The clipboard picture against the picture on screen, merged: pixels that differ, and pixels the
    // drawing changed from the magenta capture.
    const clipboardMatches = () =>
      app.evaluate(`(async () => {
        const raw = new Uint8Array(await window.__TAURI_INTERNALS__.invoke('read_clipboard_image'));
        const view = new DataView(raw.buffer);
        const w = view.getUint32(0, true), h = view.getUint32(4, true);
        // A capture copies itself and everything drawn round it; other pictures, the whole canvas.
        const s = window.sketch, doc = s.app.doc;
        const c = doc.edges ? s.flattenArea(doc, s.pictureArea(doc), null) : s.flatten(doc);
        if (c.width !== w || c.height !== h) return { size: w + ' × ' + h + ', the picture is ' + c.width + ' × ' + c.height };
        const d = c.getContext('2d').getImageData(0, 0, w, h).data;
        let bad = 0, marked = 0;
        for (let i = 0; i < d.length; i++) if (Math.abs(d[i] - raw[8 + i]) > 1) bad++;
        for (let i = 0; i < d.length; i += 4) if (d[i] !== 255 || d[i + 1] !== 0 || d[i + 2] !== 255) marked++;
        return { bad, marked };
      })()`);
    const copyLabel = () => app.evaluate(`document.querySelector('.copy-btn')?.textContent ?? ''`);
    const clickCopy = async () => {
      // The last copy's "Copied" can still be showing; wait for it to go, so the wait below is for this copy.
      await waitUntil('the last "Copied" to go', async () => (await copyLabel()) !== 'Copied', 5000);
      clipboard.text('nothing yet');
      await app.evaluate(`document.querySelector('.copy-btn').click()`);
      await waitUntil('the Copy button to say Copied', async () => (await copyLabel()) === 'Copied', 5000);
    };
    // A point on the picture, in CSS pixels from the middle of the view. Read each time: the first
    // capture check made the window smaller.
    const onPicture = async (dx, dy) => {
      const r = await app.evaluate(`(() => { const r = document.querySelector('canvas.view').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
      return [r.x + dx, r.y + dy];
    };

    await check('The Copy button copies the capture with an arrow and text drawn on it, as on screen', async () => {
      await app.press('a');
      await app.waitFor('the Arrow tool', (s) => s.tool === 'Arrow');
      await app.drag(...(await onPicture(-60, -40)), ...(await onPicture(60, 20)));
      await app.press('t');
      await app.waitFor('the Text tool', (s) => s.tool === 'Text');
      const [tx, ty] = await onPicture(-40, 50);
      await app.drag(tx, ty, tx, ty);
      await sleep(300);
      await app.send('Input.insertText', { text: 'Look here' });
      await clickCopy();
      expect(clipboard.formats().includes('PNG'), `Clipboard formats: ${clipboard.formats().join(', ')}`);
      const r = await clipboardMatches();
      expect(!r.size, `The clipboard picture is ${r.size}`);
      expect(r.marked > 200, `Only ${r.marked} pixels show the arrow and text`);
      expect(r.bad === 0, `${r.bad} clipboard values differ from the picture`);
      const tip = await app.evaluate(`document.querySelector('.copy-btn').dataset.keys`);
      expect(tip === 'Ctrl+Shift+C', `The button's tooltip shows ${tip}`);
    });

    await check('The Copy button merges every layer', async () => {
      await app.press('n', ctrl | shift);
      await app.press('b');
      await app.waitFor('the Brush tool', (s) => s.tool === 'Brush');
      await app.drag(...(await onPicture(-80, -60)), ...(await onPicture(-70, 60)));
      const layers = await app.evaluate('window.sketch.app.doc.layers.length');
      expect(layers >= 3, `The picture has ${layers} layers`);
      await clickCopy();
      const r = await clipboardMatches();
      expect(!r.size && r.bad === 0, `Clipboard against the picture: ${JSON.stringify(r)}`);
    });

    await check("A stroke past a capture's edge isn't cut off, and the copy grows to hold it", async () => {
      // From just inside the capture's right edge to 60 CSS pixels past it.
      const [x, y] = await app.evaluate(`(() => {
        const s = window.sketch, f = s.frameOf(s.app.doc), r = document.querySelector('canvas.view').getBoundingClientRect();
        const p = s.app.viewport.toScreen(f.x + f.w, f.y + f.h / 2);
        return [r.x + p.x - 20, r.y + p.y];
      })()`);
      const before = await app.evaluate('window.sketch.frameOf(window.sketch.app.doc)');
      await app.drag(x, y, x + 80, y);
      const after = await app.evaluate('window.sketch.frameOf(window.sketch.app.doc)');
      expect(after.w === before.w && after.h === before.h, `The capture changed size: ${JSON.stringify([before, after])}`);
      await clickCopy();
      const size = clipboard.pngSize();
      expect(size.w > before.w + 40 && size.h === before.h, `The copy is ${size.w} × ${size.h}, the capture ${before.w} × ${before.h}`);
      const r = await clipboardMatches();
      expect(!r.size && r.bad === 0, `Clipboard against the capture and the stroke: ${JSON.stringify(r)}`);
    });

    await check('In Window mode, clicking a window captures just that window, in a new tab of Sketch', async () => {
      const before = await captureTabs();
      const o = await startCapture();
      overlay.mode(work, o, 1);
      overlay.click(work, o, target.x + 50, target.y + 50);
      await overlay.gone(work, o);
      await clickNote();
      await waitUntil('a new tab', async () => (await captureTabs()) === before + 1);
      expect((await app.windowTitles()).length === 1, 'A new window opened');
      const size = clipboard.pngSize();
      expect(size.w === target.w && size.h === target.h, `Clipboard PNG is ${size.w} × ${size.h}, the window is ${target.w} × ${target.h}`);
    });

    await check('Ctrl+X with nothing selected copies a marked-up quick capture and closes its tab without asking', async () => {
      const before = await captureTabs();
      const tabCount = await app.evaluate('window.sketch.tabs.list.length');
      expect(tabCount > 1, `Only ${tabCount} tab is open, so Ctrl+X would close the window`);
      expect((await quickCapture()) === true, 'The capture showing is not a quick one');
      // A stroke inside the capture, so the tab has a change that would otherwise be asked about.
      await app.drag(...(await onPicture(-20, -10)), ...(await onPicture(20, 10)));
      expect(await app.evaluate('window.sketch.app.history.dirty'), 'The stroke left no change');
      expect(!(await app.evaluate('window.sketch.app.selection')), 'Something is selected');
      clipboard.text('nothing yet');
      await app.press('x', ctrl);
      await waitUntil('the capture tab to close', async () => (await captureTabs()) === before - 1, 5000);
      const size = clipboard.pngSize();
      expect(size.w === target.w && size.h === target.h, `Clipboard PNG is ${size.w} × ${size.h}, the capture was ${target.w} × ${target.h}`);
      expect(!(await app.evaluate('window.sketch.app.modal')), 'A dialog opened');
      expect((await app.windowTitles()).length === 1, 'The window closed');
    });

    await check('In Area mode a click picks nothing, and Esc cancels the capture and brings Sketch back', async () => {
      const before = await captureTabs();
      const o = await startCapture();
      overlay.click(work, o, target.x + 50, target.y + 50);
      await sleep(500);
      expect(screen(work, `[SketchScreen]::Visible(${o})`) === 'True', 'A click without a drag ended the capture');
      overlay.key(work, o, 0x1b, target.x + 50, target.y + 50);
      await overlay.gone(work, o);
      await waitUntil('Sketch to come back', async () => sketchWindows().every((w) => w.visible));
      await sleep(500);
      expect((await captureTabs()) === before && (await app.windowTitles()).length === 1, 'A tab or window opened anyway');
    });

    await check('F captures the whole screen under the pointer', async () => {
      const [w, h] = screen(work, '[SketchScreen]::Primary()').split(',').map(Number);
      const before = await captureTabs();
      const o = await startCapture();
      overlay.key(work, o, 0x46, target.x + 50, target.y + 50);
      await overlay.gone(work, o);
      await clickNote();
      await waitUntil('a new tab', async () => (await captureTabs()) === before + 1);
      const size = clipboard.pngSize();
      expect(size.w === w && size.h === h, `Clipboard PNG is ${size.w} × ${size.h}, the screen is ${w} × ${h}`);
    });

    await check('The capture shortcut (--capture) while Sketch runs opens the capture in a new tab', async () => {
      const before = await captureTabs();
      const second = spawn(exe, ['--capture'], { stdio: 'ignore', cwd: work, env: { ...process.env, ...capData.env } });
      const code = await Promise.race([new Promise((r) => second.on('exit', r)), sleep(5000).then(() => 'still running')]);
      if (code === 'still running') second.kill();
      expect(code === 0, `The second Sketch didn't hand over and exit (${code})`);
      const o = await overlay.find(work, app.pid);
      overlay.drag(work, o, target.x + 10, target.y + 10, target.x + 309, target.y + 209);
      await overlay.gone(work, o);
      await clickNote();
      await waitUntil('a new tab', async () => (await captureTabs()) === before + 1);
      expect((await app.windowTitles()).length === 1, 'A new window opened');
      const size = clipboard.pngSize();
      expect(size.w === 300 && size.h === 200, `Clipboard PNG is ${size.w} × ${size.h}`);
    });

    await check('With the switch off, the capture shortcut while Sketch runs leaves Sketch showing', async () => {
      await setHide(false);
      try {
        const second = spawn(exe, ['--capture'], { stdio: 'ignore', cwd: work, env: { ...process.env, ...capData.env } });
        await Promise.race([new Promise((r) => second.on('exit', r)), sleep(5000)]);
        const o = await overlay.find(work, app.pid);
        expect(sketchWindows().every((w) => w.visible), 'Sketch hid while the screen was picked');
        overlay.key(work, o, 0x1b, target.x + 50, target.y + 50);
        await overlay.gone(work, o);
      } finally {
        await setHide(true);
      }
    });

    await check("With Sketch open, a tap of Left Shift after Sketch's own capture opens it in a new tab, and no hook is left", async () => {
      const before = await captureTabs();
      const o = await startCapture();
      overlay.dragThenKeys(work, o, target.x + 10, target.y + 10, target.x + 129, target.y + 89, 400, 'a0d,a0u');
      await waitUntil('a new tab', async () => (await captureTabs()) === before + 1);
      await sleep(1000);
      const left = ps(`(Get-CimInstance Win32_Process -Filter "Name='sketch-capture.exe'" | Where-Object { $_.CommandLine -like '*--shift-tap=*' -and $_.CommandLine -like '*${capData.dir.replace(/'/g, "''")}*' } | Measure-Object).Count`);
      expect(left === '0', `${left} Left Shift watchers are still running`);
    });

    const setCaptureKeys = (keys) =>
      app.evaluate(`window.__TAURI_INTERNALS__.invoke('set_shortcut', { kind: 'capture', keys: ${JSON.stringify(keys)} }).then(() => 'made', (e) => String(e))`);

    await check('Settings refuses capture keys another app already holds, and Print Screen while Windows uses it', async () => {
      const holder = await holdHotkey(3, 0x78); // Ctrl+Alt+F9
      try {
        const answer = await setCaptureKeys('Ctrl+Alt+F9');
        expect(answer.startsWith('Another app already uses Ctrl+Alt+F9'), `Answer: ${answer}`);
        expect(!helper.find(work, capData.dir), 'The capture helper started anyway');
      } finally {
        holder.kill();
      }
      // Windows' own Print Screen setting decides: refused while it's on, taken when it's off.
      const owned = ps(`(Get-ItemProperty 'HKCU:\\Control Panel\\Keyboard').PrintScreenKeyForSnippingEnabled`) !== '0';
      const answer = await setCaptureKeys('PrintScreen');
      if (owned) {
        expect(answer.startsWith('Windows uses Print Screen'), `Answer with Windows using Print Screen: ${answer}`);
      } else {
        expect(answer === 'made', `Answer with Print Screen free: ${answer}`);
        expect((await setCaptureKeys(null)) === 'made', "Couldn't take Print Screen off again");
      }
    });
    await app.quit();

    await check('The capture shortcut with Sketch closed shows the overlay, and Esc quits Sketch', async () => {
      const child = spawn(exe, ['--capture'], {
        stdio: 'ignore',
        cwd: work,
        env: { ...process.env, WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview-cold'), SKETCH_TEST_MOUSE_SPEED: join(work, 'mouse-speed.txt'), ...coldData.env },
      });
      const exited = new Promise((r) => child.on('exit', r));
      const o = await overlay.find(work, child.pid);
      overlay.key(work, o, 0x1b, target.x + 50, target.y + 50);
      const code = await Promise.race([exited, sleep(8000).then(() => 'still running')]);
      if (code === 'still running') child.kill();
      expect(code === 0, `Sketch didn't quit after Esc (${code})`);
    });

    await check('With Sketch closed, the shortcut stays hidden until the notification is clicked, then opens the capture in the first window', async () => {
      app = await launch(exe, work, ['--capture'], null, coldData.env);
      const o = await overlay.find(work, app.pid);
      expect(!sketchWindows()[0]?.visible, 'The window showed while the screen was picked');
      overlay.drag(work, o, target.x + 10, target.y + 10, target.x + 309, target.y + 209);
      await overlay.gone(work, o);
      await waitUntil('the clipboard', async () => clipWidth() === 300);
      await sleep(500);
      expect(!sketchWindows()[0]?.visible, 'The window showed before the notification was clicked');
      await clickNote();
      const s = await app.waitFor('the capture', (s) => s.size === '300 × 200 px');
      expect(s.tool === 'Brush', `Tool after capturing: ${s.tool}`);
      const color = await app.evaluate('window.sketch.app.primary');
      expect(color === '#ed1c24', `Colour 1 after capturing: ${color}`);
      await waitUntil('the window to show', async () => sketchWindows()[0]?.visible);
      expect((await notMagenta()) === 0, 'The capture is not the magenta window');
      expect((await quickCapture()) === true, 'The capture from the notification would still ask before closing');
    });

    await check('Once a capture from its notification is saved, closing it with changes asks again', async () => {
      const file = join(work, 'capture.png');
      await app.press('s', ctrl | shift);
      await app.waitFor('the Save As box', (s) => s.dialog === 'Save As');
      await app.press('Enter');
      fillFileDialog(app.pid, file);
      await app.waitFor('the save', (s) => s.title === 'capture.png - Sketch');
      expect((await quickCapture()) === false, 'The saved capture still closes without asking');
      await app.drag(...(await onPicture(-40, 0)), ...(await onPicture(40, 20)));
      await app.waitFor('the change', (s) => s.title === 'capture.png* - Sketch');
      postClose(app.pid);
      await app.waitFor('the unsaved changes box', (s) => s.dialog === 'Save your changes?');
      await app.clickButton("Don't Save").catch(() => {});
      expect(await app.quit(5000), "Sketch didn't close");
    });
    await app.quit();

    // ---------- The capture helper ----------

    const bg = dataFor('background');
    const sketchPids = () =>
      ps(`Get-CimInstance Win32_Process -Filter "Name='sketch.exe'" | Where-Object { $_.CommandLine -like '*${bg.dir.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`)
        .split(/\s+/)
        .filter(Boolean)
        .map(Number);
    let helperWindow = 0;
    let helperPid = 0;
    let port = 0;
    // F12: a hidden Sketch starts with each capture while Sketch is closed.
    const hiddenSketch = async () => {
      let pid = 0;
      await waitUntil('the hidden Sketch to start', async () => (pid = sketchPids()[0] ?? 0) !== 0);
      await waitUntil('its window', async () => screen(work, `[SketchScreen]::Windows(${pid})`) !== '');
      return pid;
    };
    const windowsOf = (pid) =>
      screen(work, `[SketchScreen]::Windows(${pid})`)
        .split(',')
        .filter(Boolean)
        .map((s) => ({ h: Number(s.split(':')[0]), visible: s.endsWith(':1') }));
    const shownWindows = (pid) => windowsOf(pid).filter((w) => w.visible).length;
    const alive = (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    /** Working set and private memory in MB of a process and everything it started (WebView2's processes). */
    const treeMemory = (pid) =>
      ps(`$all = Get-CimInstance Win32_Process; $ids = [System.Collections.Generic.List[int]]::new(); $ids.Add(${pid}); $i = 0
while ($i -lt $ids.Count) { foreach ($c in $all) { if ($c.ParentProcessId -eq $ids[$i]) { $ids.Add([int]$c.ProcessId) } }; $i++ }
$p = Get-Process -Id $ids -ErrorAction SilentlyContinue; "$(($p | Measure-Object WorkingSet64 -Sum).Sum) $(($p | Measure-Object PrivateMemorySize64 -Sum).Sum)"`)
        .split(' ')
        .map((n) => Number(n) / 2 ** 20);
    /** With Sketch closed: the keys, then a drag of w × h over the magenta window, and `keys` (sent as the keyboard would) once the overlay has closed. */
    const helperCapture = async (w, h, keys = null) => {
      helper.keys(work, helperWindow);
      const o = await overlay.find(work, helperPid).catch((e) => {
        const fg = Number(screen(work, '[SketchScreen]::Foreground()'));
        const owner = Number(screen(work, `[SketchScreen]::Pid(${fg})`));
        const others = sketchPids().map((p) => `${p}:${screen(work, `[SketchScreen]::Overlay(${p})`)}`);
        throw new Error(`${e.message} (in front: process ${owner}${sketchPids().includes(owner) ? ', a Sketch' : ''}; Sketch processes and overlays: ${others.join(' ') || 'none'})`);
      });
      // 400 ms: about when the notification has slid in, well inside the second.
      if (keys) overlay.dragThenKeys(work, o, target.x + 10, target.y + 10, target.x + 9 + w, target.y + 9 + h, 400, keys);
      else overlay.drag(work, o, target.x + 10, target.y + 10, target.x + 9 + w, target.y + 9 + h);
      await overlay.gone(work, o);
    };
    const noteLife = (ms) => (ms ? writeFileSync(join(bg.dir, 'note-ms.txt'), String(ms)) : rmSync(join(bg.dir, 'note-ms.txt'), { force: true }));
    // The keys with Sketch open: in front, Sketch takes the capture itself (it hides first);
    // otherwise the helper does. Returns the overlay and the process showing it.
    const pressKeys = async () => {
      helper.keys(work, helperWindow);
      let o = 0;
      let owner = 0;
      await waitUntil('the overlay', async () => {
        for (const pid of [helperPid, app.pid]) {
          o = Number(screen(work, `[SketchScreen]::Overlay(${pid})`));
          if (o) return (owner = pid);
        }
        return false;
      });
      console.log(`      Captured by ${owner === helperPid ? 'the helper' : 'Sketch, which was in front'}`);
      return { o, owner };
    };
    const captureRow = `document.querySelector('[data-command="file.capture"]')`;
    try {
      await check('Capture Screen\'s shortcut in Settings starts the capture helper, which keeps it working after Sketch closes', async () => {
        app = await launch(exe, work, [], 'background', bg.env);
        port = app.port;
        await app.press(',', ctrl);
        await sleep(200);
        await app.evaluate(`${captureRow}.querySelector('.key-btn').click()`);
        await sleep(100);
        // Alt+Shift with no Ctrl: the helper's RegisterHotKey takes it, where a Start menu shortcut couldn't.
        await app.press('F10', 1 | shift);
        helperWindow = await helper.wait(work, bg.dir);
        helperPid = helper.pid(work, helperWindow);
        expect(existsSync(join(bg.dir, 'run-entry.txt')), 'No sign-in entry (its stand-in file) was made');
        const held = await app.evaluate(`window.__TAURI_INTERNALS__.invoke('shortcut', { kind: 'capture' })`);
        expect(held === 'Alt+Shift+F10', `The helper holds ${held}`);
        const shown = await app.evaluate(`${captureRow}.querySelector('.key-btn').textContent`);
        expect(shown === 'Alt+Shift+F10', `Settings shows ${shown}`);
        const saved = await app.evaluate(`localStorage.getItem('sketch.keys')`);
        expect(!saved?.includes('file.capture'), `The key was also saved as an in-app shortcut: ${saved}`);
        expect(!(await app.evaluate(`!!document.querySelector('[data-setting="captureBackground"]')`)), 'The "Keep capture ready" switch is still in Settings');
        await app.press('Escape');
        postClose(app.pid);
        expect(await app.quit(8000), "Sketch didn't close");
        await sleep(500);
        expect(helper.find(work, bg.dir) === helperWindow, 'The capture helper quit with Sketch');
      });

      await check('With Sketch closed, the keys show the overlay at once, and the capture goes on the clipboard', async () => {
        const times = [];
        for (let i = 0; i < 3; i++) {
          const ms = helper.timeOverlay(work, helperWindow, helperPid);
          expect(ms >= 0, 'The overlay never showed');
          times.push(ms);
          const o = await overlay.find(work, helperPid);
          if (i < 2) {
            overlay.key(work, o, 0x1b, target.x + 50, target.y + 50);
            await overlay.gone(work, o);
            await sleep(300);
          } else {
            overlay.drag(work, o, target.x + 10, target.y + 10, target.x + 309, target.y + 209);
            await overlay.gone(work, o);
          }
        }
        console.log(`      Overlay after ${times.join(', ')} ms`);
        await waitUntil('the clipboard', async () => clipWidth() === 300);
      });

      await check('With Sketch closed, the capture starts a hidden Sketch with it, which shows nothing', async () => {
        const pid = await hiddenSketch();
        expect(!shownWindows(pid), 'Sketch showed a window before the notification was clicked');
        // Long enough for its page to have drawn the capture.
        await sleep(2000);
        expect(!shownWindows(pid), 'Sketch showed a window before the notification was clicked');
        const [ws, priv] = treeMemory(pid);
        console.log(`      Hidden Sketch with its WebView2: working set ${ws.toFixed(0)} MB, private ${priv.toFixed(0)} MB`);
      });

      await check("Clicking the helper's notification shows the hidden Sketch with the capture at once", async () => {
        const pid = sketchPids()[0];
        const { posted, ms } = helper.timeShown(work, helperWindow, pid);
        expect(ms >= 0, 'Sketch never showed');
        app = await attach(port, pid);
        const s = await app.waitFor('the capture', (s) => s.size === '300 × 200 px');
        const frame = await app.evaluate('window.sketchShownAt ?? null');
        console.log(`      Window shown ${ms.toFixed(0)} ms after the click, its first frame started after ${frame === null ? '?' : (frame - posted).toFixed(0)} ms`);
        expect(ms < 100, `The window took ${ms.toFixed(0)} ms to show`);
        expect(notesInCentre(helperPid) === 0, 'The notification is still in the notification centre');
        expect(s.tool === 'Brush', `Tool after capturing: ${s.tool}`);
        expect((await notMagenta()) === 0, 'The capture is not the magenta window');
        const left = readdirSync(join(bg.dir, 'captures')).filter((f) => f.endsWith('.rgba'));
        expect(left.length === 0, `Captures left waiting: ${left.join(', ')}`);
      });

      await check("A capture opened from the helper's notification closes with changes and no question, and leaves no autosave", async () => {
        expect((await quickCapture()) === true, 'The capture is not marked to close without asking');
        await app.press('a');
        await app.waitFor('the Arrow tool', (s) => s.tool === 'Arrow');
        await app.drag(...(await onPicture(-60, -40)), ...(await onPicture(60, 20)));
        await app.waitFor('the arrow', (s) => s.title.endsWith('* - Sketch'));
        await waitUntil('the autosave', () => slots(bg.dir, '.sktch').length === 1, 8000);
        postClose(app.pid);
        expect(await app.quit(5000), 'Sketch asked about saving, or stayed open');
        const left = slots(bg.dir, '.json');
        expect(left.length === 0, `Autosaves left: ${left.join(', ')}`);
      });

      // ---------- Instant open from the notification (F12), Sketch closed ----------

      await check('A capture not clicked loses its notification after 3 seconds, with nothing left in the notification centre, and its hidden Sketch closes', async () => {
        noteLife(0);
        try {
          await helperCapture(250, 150);
          const t0 = Date.now();
          const pid = await hiddenSketch();
          await waitUntil('the hidden Sketch to close', async () => !alive(pid), 8000);
          const s = (Date.now() - t0) / 1000;
          console.log(`      Closed ${s.toFixed(1)} s after the capture`);
          expect(s > 2.5, `The hidden Sketch closed after only ${s.toFixed(1)} s`);
          expect(notesInCentre(helperPid) === 0, 'The notification is still in the notification centre');
          expect(sketchPids().length === 0, 'A Sketch process is left');
          const left = readdirSync(join(bg.dir, 'captures')).filter((f) => f.endsWith('.rgba'));
          expect(left.length === 0, `Captures left: ${left.join(', ')}`);
          expect(slots(bg.dir, '.json').length === 0, 'The hidden Sketch left an autosave');
          expect(clipWidth() === 250, 'The capture is no longer on the clipboard');
        } finally {
          noteLife(60000);
        }
      });

      await check('Dismissing the notification closes the hidden Sketch too', async () => {
        await helperCapture(250, 150);
        const pid = await hiddenSketch();
        await sleep(1500);
        helper.dismiss(work, helperWindow);
        await waitUntil('the hidden Sketch to close', async () => !alive(pid), 5000);
        expect(notesInCentre(helperPid) === 0, 'The notification is still in the notification centre');
      });

      await check('A click before the hidden Sketch has finished starting shows the capture once it is ready', async () => {
        await helperCapture(220, 120);
        helper.click(work, helperWindow);
        let pid = 0;
        // The click can reach a second sketch.exe before the hidden one holds the pipe; either way one shows it.
        await waitUntil('Sketch to show', async () => (pid = sketchPids().find((p) => shownWindows(p) === 1) ?? 0) !== 0);
        app = await attach(port, pid);
        await app.waitFor('the capture', (s) => s.size === '220 × 120 px');
        expect((await quickCapture()) === true, 'The capture is not marked to close without asking');
        postClose(app.pid);
        expect(await app.quit(5000), 'Sketch asked about saving, or stayed open');
      });

      await check('A second capture replaces the waiting one: one hidden window, one notification, and the click shows the newer capture', async () => {
        await helperCapture(240, 140);
        const pid = await hiddenSketch();
        await sleep(1500);
        await helperCapture(180, 100);
        await waitUntil('the older hidden window to close', async () => windowsOf(pid).length === 1, 5000);
        expect(sketchPids().length === 1, 'A second Sketch started');
        expect(shownWindows(pid) === 0, 'A window showed');
        // Checks' notifications skip the pop-up and go straight to the notification centre.
        expect(notesInCentre(helperPid) === 1, `${notesInCentre(helperPid)} notifications in the notification centre`);
        await sleep(1500);
        helper.click(work, helperWindow);
        await waitUntil('Sketch to show', async () => shownWindows(pid) === 1);
        app = await attach(port, pid);
        await app.waitFor('the newer capture', (s) => s.size === '180 × 100 px');
        postClose(app.pid);
        expect(await app.quit(5000), 'Sketch asked about saving, or stayed open');
      });

      await check('Opening Sketch another way while it waits hidden opens a normal window, and only the hidden one closes with the notification', async () => {
        await helperCapture(240, 140);
        const pid = await hiddenSketch();
        await sleep(1500);
        // As the Start menu would: a plain start, which hands over to the running Sketch.
        const second = spawn(exe, [], { stdio: 'ignore', cwd: work, env: { ...process.env, ...bg.env } });
        await new Promise((r) => second.on('exit', r));
        await waitUntil('a window to show', async () => shownWindows(pid) === 1);
        helper.dismiss(work, helperWindow);
        await waitUntil('the hidden window to close', async () => windowsOf(pid).length === 1, 5000);
        expect(alive(pid), 'Sketch quit with the hidden window');
        expect(shownWindows(pid) === 1, 'The window opened from the Start menu went');
        app = await attach(port, pid);
        const s = await app.state();
        expect(s.size !== '240 × 140 px', 'The shown window has the capture');
        postClose(app.pid);
        expect(await app.quit(5000), "Sketch didn't close");
      });

      // ---------- Open a capture with Left Shift (F16), Sketch closed ----------
      // Keys go in through SendInput, to whatever window is in front, so only keys that type nothing.
      const TAP = 'a0d,a0u';
      const settingsFile = join(bg.dir, 'capture.json');
      const setCapture = (change) => writeFileSync(settingsFile, JSON.stringify({ ...JSON.parse(readFileSync(settingsFile, 'utf8')), ...change }));
      /** After a capture that shouldn't open: nothing shows, and the hook is gone after its second. */
      const expectNothingOpens = async (what) => {
        await sleep(1300);
        const pid = sketchPids()[0] ?? 0;
        expect(!pid || !shownWindows(pid), `Sketch showed the capture for ${what}`);
        expect(helper.watching(work, helperWindow) === 0, `A Left Shift hook is still installed after ${what}`);
        helper.dismiss(work, helperWindow);
        await waitUntil('the hidden Sketch to close', async () => sketchPids().length === 0, 5000);
      };

      await check('With Sketch closed, a tap of Left Shift just after a capture opens it and takes its notification away, and no hook is left', async () => {
        await helperCapture(260, 160, TAP);
        let pid = 0;
        await waitUntil('Sketch to show', async () => (pid = sketchPids().find((p) => shownWindows(p) === 1) ?? 0) !== 0);
        app = await attach(port, pid);
        await app.waitFor('the capture', (s) => s.size === '260 × 160 px');
        expect(notesInCentre(helperPid) === 0, 'The notification is still in the notification centre');
        expect((await quickCapture()) === true, 'The capture is not marked to close without asking');
        await sleep(1000);
        expect(helper.watching(work, helperWindow) === 0, 'A Left Shift hook is still installed');
        postClose(app.pid);
        expect(await app.quit(5000), 'Sketch asked about saving, or stayed open');
      });

      await check('With the hidden Sketch ready, a tap shows the capture at once', async () => {
        helper.keys(work, helperWindow);
        const o = await overlay.find(work, helperPid);
        // As late in the second as is safe, so the hidden Sketch has drawn the capture.
        const { ms } = overlay.dragTapShown(work, o, target.x + 10, target.y + 10, target.x + 269, target.y + 169, 750, exe);
        expect(ms >= 0, 'Sketch never showed');
        console.log(`      Window shown ${ms.toFixed(0)} ms after the tap`);
        expect(ms < 100, `The window took ${ms.toFixed(0)} ms to show`);
        const pid = sketchPids().find((p) => shownWindows(p) === 1);
        app = await attach(port, pid);
        await app.waitFor('the capture', (s) => s.size === '260 × 160 px');
        postClose(app.pid);
        expect(await app.quit(5000), 'Sketch asked about saving, or stayed open');
      });

      await check('Nothing opens for a tap after the second, Shift with another key, Right Shift, or a Shift held from before the capture', async () => {
        await helperCapture(260, 160);
        await sleep(1500);
        keys(work, TAP);
        await expectNothingOpens('a tap after 1.5 s');

        // Shift+F24 (types nothing), then Right Shift alone.
        await helperCapture(260, 160, 'a0d,87d,87u,a0u,a1d,a1u');
        await expectNothingOpens('Shift+F24 and Right Shift');

        keys(work, 'a0d');
        try {
          await helperCapture(260, 160);
          await sleep(200);
        } finally {
          keys(work, 'a0u');
        }
        await expectNothingOpens('the release of a Shift held from before');
      });

      await check('With the switch off, or After a Capture set to open at once, no Left Shift hook is installed', async () => {
        try {
          setCapture({ shift_open: false });
          await helperCapture(260, 160, TAP);
          expect(helper.watching(work, helperWindow) === 0, 'A hook was installed with the switch off');
          await expectNothingOpens('a tap with the switch off');
          setCapture({ shift_open: true, after: 'open' });
          await helperCapture(260, 160);
          let pid = 0;
          await waitUntil('Sketch to open the capture', async () => (pid = sketchPids().find((p) => shownWindows(p) === 1) ?? 0) !== 0);
          expect(helper.watching(work, helperWindow) === 0, 'A hook was installed for a capture that opens at once');
          app = await attach(port, pid);
          await app.waitFor('the capture', (s) => s.size === '260 × 160 px');
          await app.quit();
        } finally {
          setCapture({ shift_open: true, after: 'notify' });
        }
      });

      await check('With Sketch open on a changed picture, the keys capture, the notification opens a new tab, and only that tab closes without asking', async () => {
        app = await launch(exe, work, [], 'background', bg.env);
        await app.drag(...(await onPicture(-40, 0)), ...(await onPicture(40, 20)));
        await app.waitFor('the change', (s) => s.title === 'Untitled* - Sketch');
        const handles = sketchWindows().map((w) => w.h);
        const { o, owner } = await pressKeys();
        overlay.drag(work, o, target.x + 10, target.y + 10, target.x + 209, target.y + 109);
        await overlay.gone(work, o);
        await waitUntil('the clipboard', async () => clipWidth() === 200);
        await sleep(500);
        expect(sketchPids().length === 0 && sketchWindows().length === handles.length, 'The open Sketch made a hidden window for the capture, or another Sketch started');
        if (owner === helperPid) helper.click(work, helperWindow);
        else await clickNote();
        await app.waitFor('a new tab', (s) => s.tabs === 2);
        expect(sketchWindows().length === handles.length, 'A new window opened');
        // Let the capture's paste land, so the tab has a change that would ask.
        await sleep(1000);
        expect(await quickCapture(), "The capture isn't marked as opened from its notification");
        await app.press('F4', ctrl);
        await app.waitFor('the capture tab to close', (s) => s.tabs === 1, 5000);
        expect((await app.state()).dialog === null, 'The capture tab asked about saving');
        postClose(app.pid);
        await app.waitFor('the other tab to ask', (s) => s.dialog === 'Save your changes?');
        await app.press('Escape');
        await app.waitFor('the box to close', (s) => s.dialog === null);
      });

      await check('"Open it in Sketch" opens a capture without a notification', async () => {
        await app.evaluate(`window.__TAURI_INTERNALS__.invoke('capture_options_set', { after: 'open' })`);
        const before = await captureTabs();
        const { o } = await pressKeys();
        overlay.drag(work, o, target.x + 10, target.y + 10, target.x + 109, target.y + 109);
        await overlay.gone(work, o);
        await waitUntil('a new tab', async () => (await captureTabs()) === before + 1);
        await app.evaluate(`window.__TAURI_INTERNALS__.invoke('capture_options_set', { after: 'notify' })`);
      });

      await check('The capture helper is small while it waits, and a second one quits at once', async () => {
        const [ws, priv] = ps(`$p = Get-Process -Id ${helperPid}; "$($p.WorkingSet64) $($p.PrivateMemorySize64)"`).split(' ').map((n) => Number(n) / 2 ** 20);
        console.log(`      Working set ${ws.toFixed(1)} MB, private ${priv.toFixed(1)} MB`);
        expect(priv < 30, `The idle helper holds ${priv.toFixed(1)} MB`);
        const second = spawn(join(exe, '..', 'sketch-capture.exe'), [], { stdio: 'ignore', env: { ...process.env, ...bg.env, SKETCH_TEST_HOOKS: '1' } });
        const code = await Promise.race([new Promise((r) => second.on('exit', r)), sleep(3000).then(() => 'still running')]);
        if (code === 'still running') second.kill();
        expect(code === 0, `The second helper didn't quit (${code})`);
        expect(helper.find(work, bg.dir) === helperWindow, 'The first helper went away');
      });

      await check('Removing Capture Screen\'s shortcut in Settings stops the helper and takes out the sign-in entry', async () => {
        await app.press(',', ctrl);
        await sleep(200);
        await app.evaluate(`[...${captureRow}.querySelectorAll('.link')].find((b) => b.textContent === 'Remove').click()`);
        await helper.wait(work, bg.dir, false);
        expect(!existsSync(join(bg.dir, 'run-entry.txt')), 'The sign-in entry (its stand-in file) is still there');
        const shown = await app.evaluate(`${captureRow}.querySelector('.key-btn').textContent`);
        expect(shown === 'None', `Settings shows ${shown}`);
        await app.quit();
      });

      // Until 22 Oct 2026 Capture Screen could have an in-app shortcut apart from the capture keys.
      const old = dataFor('old-keys');
      await check('An in-app Capture Screen shortcut from before becomes the capture key, held with Sketch closed', async () => {
        app = await launch(exe, work, [], 'old-keys', old.env);
        // The start saves the shortcuts once it has asked the helper for its key; write the old ones after that.
        await waitUntil('the shortcuts to be saved', async () => (await app.evaluate(`localStorage.getItem('sketch.keys')`)) !== null);
        await app.evaluate(`localStorage.setItem('sketch.keys', JSON.stringify({ 'file.capture': ['Alt+Shift+F11'], 'edit.swapColors': ['Q'] }))`);
        postClose(app.pid);
        expect(await app.quit(5000), "Sketch didn't close");
        app = await launch(exe, work, [], 'old-keys', old.env);
        const h = await helper.wait(work, old.dir);
        try {
          const held = await app.evaluate(`window.__TAURI_INTERNALS__.invoke('shortcut', { kind: 'capture' })`);
          expect(held === 'Alt+Shift+F11', `The helper holds ${held}`);
          const saved = await app.evaluate(`localStorage.getItem('sketch.keys')`);
          expect(saved === '{"edit.swapColors":["Q"]}', `Saved shortcuts: ${saved}`);
          expect(existsSync(join(old.dir, 'run-entry.txt')), 'No sign-in entry (its stand-in file) was made');
          postClose(app.pid);
          expect(await app.quit(8000), "Sketch didn't close");
          await sleep(500);
          expect(helper.find(work, old.dir) === h, 'The capture helper quit with Sketch');
        } finally {
          try {
            process.kill(helper.pid(work, h));
          } catch {}
        }
      });
    } finally {
      // Never leave a helper running after the checks.
      const h = helper.find(work, bg.dir);
      if (h) {
        try {
          process.kill(helper.pid(work, h));
        } catch {}
      }
    }
  } finally {
    magenta.child.kill();
  }
} finally {
  await app?.quit();
  server.close();
  // WebView2's helper processes can hold the folder for a moment after the app exits.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {}
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed.`);
if (failed) process.exit(1);
