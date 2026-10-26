// Checks Silent Updates (F6) and the update ready icon (F11) end to end, in a scratch install folder
// laid out the way the installer lays it out, against a throwaway clone of the repo so nothing is
// pushed. Nothing touches the installed Sketch, its shortcuts or the registry.
//  1. The installer's own layout and uninstall steps (the SKETCH_LAYOUT and SKETCH_REMOVE_VERSIONS
//     macros in src-tauri/windows/hooks.nsh), compiled with Tauri's NSIS and run on a scratch folder
//     holding an old single-exe Sketch.
//  2. Through the launcher, Sketch opens the version current.json names, its window's relaunch
//     command is the launcher, the capture helper's sign-in entry goes through the launcher, and
//     `--capture-helper` starts the current version's helper.
//  3. A new commit on the clone's origin/main is built in the background, in its own worktree
//     (without an uncommitted edit, and in place of a leftover build folder from another clone), and
//     staged as a new version folder with current.json naming it, while the running Sketch keeps
//     working and shows nothing about updates in the menu bar.
//  4. The update ready icon (F11): absent while the build runs, there within one check once it's
//     staged, in the status bar's text colour in light and dark, doing nothing when clicked, and
//     Restart to Update is in the Help menu.
//  5. The quiet restart: with Sketch in the background and the idle time shortened, it restarts into
//     the new version by itself, and its windows come back with their pictures, places and minimised
//     state, without the focus and without messages. The launcher then keeps only the current and
//     previous version folders, the new Sketch replaces the old capture helper, and the icon is gone.
//  6. Restart to Update brings the windows back in front, on the version current.json names.
//  7. The launcher: a half-copied folder is never started, a missing folder falls back to the newest
//     other version and Sketch says so once.
//  8. Start-up through the launcher stays within the speed budget.
// Usage: node scripts/update-check.mjs
//
// The app under test is this checkout's release build (npm run tauri build, or with -- --no-bundle):
// src-tauri/target/release's sketch.exe, sketch-capture.exe and sketch-launcher.exe. The clone starts
// from this checkout's HEAD plus its uncommitted Sketch changes (one commit), so the build staged in
// step 3 has the code as it is now. That build compiles everything from scratch the first time, so
// this takes 5 to 15 minutes. The quiet restart waits for 2 seconds with no keyboard or mouse input,
// so leave the PC alone when step 5 starts. Windows only.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { attach, captureTarget, clipboard, png, ps, screen, sleep } from './native-driver.mjs';
import { pingSketch } from './ping-sketch.mjs';

const sketchDir = resolve('.');
const repo = execFileSync('git', ['-C', sketchDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
// Sketch's folder inside the repo, the same in the clone (`apps/sketch`; '.' when it's the repo's root).
const rel = execFileSync('git', ['-C', sketchDir, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim().replace(/\/$/, '') || '.';
const release = join(sketchDir, 'src-tauri', 'target', 'release');
const exes = ['sketch.exe', 'sketch-capture.exe', 'sketch-launcher.exe'].map((f) => join(release, f));
if (exes.some((f) => !existsSync(f))) {
  console.error('Build the app first with: npm run tauri build -- --no-bundle');
  process.exit(1);
}
const [appExe, helperExe, launcherExe] = exes;

const work = mkdtempSync(join(tmpdir(), 'sketch-update-'));
const clone = join(work, 'repo');
const data = join(work, 'data');
const install = join(work, 'install');
const launcher = join(install, 'sketch.exe');
mkdirSync(data);
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitEnv = { GIT_AUTHOR_NAME: 'Update check', GIT_AUTHOR_EMAIL: 'check@example.com', GIT_COMMITTER_NAME: 'Update check', GIT_COMMITTER_EMAIL: 'check@example.com' };
const commitIn = (cwd, message) => {
  execFileSync('git', ['-C', cwd, 'add', '-A', rel], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', message], { stdio: 'ignore', env: { ...process.env, ...gitEnv } });
  return git(cwd, 'rev-parse', 'HEAD');
};
const short = (c) => c.slice(0, 7);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

const results = [];
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
/** Each step has a time limit, so a Sketch that dies mid-step fails it instead of leaving the check waiting for ever. */
async function check(name, fn, ms = 5 * 60_000) {
  try {
    let timer;
    await Promise.race([fn(), new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`The step took over ${ms / 60_000} minutes`)), ms)))]).finally(() => clearTimeout(timer));
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
    throw e;
  }
}
const waitUntil = async (what, test, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(500);
  }
  throw new Error(`Timed out after ${Math.round(ms / 1000)} s waiting for ${what}`);
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const current = () => readJson(join(install, 'current.json'));
const setCurrent = (folder, commit, previous = '') => writeFileSync(join(install, 'current.json'), JSON.stringify({ folder, commit, previous }));

/** A version folder as the installer or the update build leaves it. */
function makeVersion(folder, commit, builtAt = new Date().toISOString(), from = { app: appExe, helper: helperExe }) {
  const dir = join(install, folder);
  mkdirSync(dir, { recursive: true });
  cpSync(from.app, join(dir, 'sketch.exe'));
  cpSync(from.helper, join(dir, 'sketch-capture.exe'));
  writeFileSync(join(dir, 'version.json'), JSON.stringify({ builtAt, commit }));
}

/** Sketch processes running from this install folder's version folders: [{ pid, path }]. */
function running() {
  const out = ps(`Get-Process sketch -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\app-*' } | ForEach-Object { "$($_.Id)|$($_.Path)" }; exit 0`);
  return out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => {
      const [pid, path] = l.split('|');
      return { pid: Number(pid), path };
    });
}

/** The helper's processes for this install folder. */
const helpers = () => ps(`Get-Process sketch-capture -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\*' } | ForEach-Object { $_.Path }; exit 0`).split(/\r?\n/).filter(Boolean);

// Every launch shares one debugging port and WebView2 folder, so a Sketch the launcher starts by
// itself (a restart) can be reached the same way.
const port = 9300 + Math.floor(Math.random() * 600);
const mouseSpeed = join(work, 'mouse-speed.txt');
writeFileSync(mouseSpeed, '10');
const env = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview'),
  SKETCH_DATA_DIR: data,
  SKETCH_TEST_HOOKS: '1',
  SKETCH_TEST_MOUSE_SPEED: mouseSpeed,
  SKETCH_UPDATE_REPO: clone,
};
// The quiet restart waits until the check sets a short idle time here.
const holdQuietRestart = () => writeFileSync(join(data, 'idle-seconds.txt'), '86400');
holdQuietRestart();

/** Starts the launcher with `args` and connects to the Sketch it starts (or, with `waitFor`, the one matching it). */
async function viaLauncher(args = [], waitFor = () => true) {
  const before = new Set(running().map((r) => r.pid));
  spawn(launcher, args, { stdio: 'ignore', cwd: work, env, detached: true }).unref();
  let found;
  await waitUntil('Sketch to start through the launcher', () => (found = running().find((r) => !before.has(r.pid) && waitFor(r))), 20_000);
  return { app: await attach(port, found.pid), ...found };
}

/** Waits for a Sketch started by something else (a restart), and connects to it. */
async function attachNew(oldPid, ms) {
  let found;
  await waitUntil('the restarted Sketch', () => (found = running().find((r) => r.pid !== oldPid)), ms);
  // Its page needs a moment before the debugging port lists it.
  return { app: await attach(port, found.pid), ...found };
}

const icon = (app) => app.evaluate(`(() => { const i = document.querySelector('.st-update'); return i && { role: i.getAttribute('role'), label: i.getAttribute('aria-label'), tip: i.dataset.tip ?? null, svg: !!i.querySelector('svg circle') }; })()`);
const sketchInFront = (pid) => Number(screen(work, `[SketchScreen]::Pid([SketchScreen]::Foreground())`)) === pid;
const windowsOf = (pid) =>
  screen(work, `[SketchScreen]::Titled(${pid})`)
    .split(';')
    .filter(Boolean)
    .map((w) => {
      const [h, title, visible, iconic] = w.split('|');
      return { h: Number(h), title, visible: visible === '1', iconic: iconic === '1' };
    });

// ---------- The clone: HEAD, then the working tree's Sketch changes, then a pushed commit ----------

// The commit the app under test was built from (its stamp), which is HEAD unless someone has
// committed since the build; then the app would rightly count HEAD as an update waiting.
const base = readJson(join(sketchDir, 'src-tauri', 'stamp.json'))?.commit || git(repo, 'rev-parse', 'HEAD');
execFileSync('git', ['clone', '-q', '--no-checkout', repo, clone], { stdio: 'ignore' });
git(clone, 'checkout', '-q', '--detach', base);
const changed = git(repo, 'ls-files', '-m', '-o', '--exclude-standard', '--', rel).split('\n').filter(Boolean);
for (const f of changed) {
  mkdirSync(dirname(join(clone, f)), { recursive: true });
  cpSync(join(repo, f), join(clone, f));
}
const working = changed.length ? commitIn(clone, 'Sketch as it is in the working tree') : base;
writeFileSync(join(clone, rel, 'README.md'), readFileSync(join(clone, rel, 'README.md'), 'utf8') + '\n<!-- update check -->\n');
const pushed = commitIn(clone, 'Update check: a pushed change');
git(clone, 'update-ref', 'refs/remotes/origin/main', pushed);
// The clone's origin is a local bare repo holding the pushed commit, so Sketch's own fetch (F16)
// keeps origin/main where the check put it instead of reaching this checkout's main.
const origin = join(work, 'origin.git');
execFileSync('git', ['init', '-q', '--bare', origin], { stdio: 'ignore' });
execFileSync('git', ['-C', origin, 'fetch', '-q', clone, `${pushed}:refs/heads/main`], { stdio: 'ignore' });
git(clone, 'remote', 'set-url', 'origin', origin);
// An edit nobody committed, which must not end up in the update.
const marker = `uncommitted-edit-${Date.now()}`;
writeFileSync(join(clone, rel, 'src', 'uncommitted.ts'), `export const marker = '${marker}';\n`);
// A build folder left by a Sketch installed from another clone (the old repo, after a move), which
// can't check out this clone's commits: the update must make the worktree again instead of failing.
const leftover = join(data, 'build', 'sketch-update-build');
mkdirSync(leftover, { recursive: true });
git(leftover, 'init', '-q');
console.log(`Clone at ${clone}: running build ${short(base)}, pushed ${short(pushed)}${working !== base ? ` (working tree ${short(working)})` : ''}`);

let app;
let target;
// A Sketch the check attached to isn't its child, so Node would otherwise exit mid-wait with nothing left to run.
const keepAlive = setInterval(() => {}, 1000);
try {
  await check("The installer's layout step turns an old single-exe Sketch into the launcher layout, and its uninstall step removes every version", async () => {
    const makensis = join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe');
    expect(existsSync(makensis), `Tauri's NSIS isn't at ${makensis}; npm run tauri build downloads it`);
    const nsh = join(sketchDir, 'src-tauri', 'windows', 'hooks.nsh');
    const version = readFileSync(join(sketchDir, 'src-tauri', 'windows', 'version.nsh'), 'utf8');
    const folder = /SKETCH_VERSION_FOLDER "([^"]+)"/.exec(version)[1];
    const script = join(work, 'layout-test.nsi');
    writeFileSync(
      script,
      `Unicode true
!include LogicLib.nsh
!define MAINBINARYNAME "sketch"
!include "${nsh}"
OutFile "${join(work, 'layout-test.exe')}"
RequestExecutionLevel user
SilentInstall silent
Section
  ReadEnvStr $INSTDIR SKETCH_TEST_INSTDIR
  ReadEnvStr $0 SKETCH_TEST_STEP
  \${If} $0 == "layout"
    !insertmacro SKETCH_LAYOUT
  \${Else}
    !insertmacro SKETCH_REMOVE_VERSIONS
  \${EndIf}
SectionEnd
`,
    );
    const compiled = spawnSync(makensis, ['/V2', script], { encoding: 'utf8' });
    expect(compiled.status === 0, `makensis failed:\n${compiled.stdout}${compiled.stderr}`);
    const dir = join(work, 'nsis-install');
    const runStep = (step) => execFileSync(join(work, 'layout-test.exe'), [], { env: { ...process.env, SKETCH_TEST_INSTDIR: dir, SKETCH_TEST_STEP: step } });
    const bytes = (f) => readFileSync(f);
    // An old install, then the files Tauri's install section copies over it.
    mkdirSync(dir);
    writeFileSync(join(dir, 'sketch-capture.exe'), 'old helper');
    writeFileSync(join(dir, 'uninstall.exe'), 'uninstaller');
    for (const [from, to] of [
      [appExe, 'sketch.exe'],
      [helperExe, 'sketch-capture.exe'],
      [launcherExe, 'sketch-launcher.exe'],
    ])
      cpSync(from, join(dir, to));
    runStep('layout');
    expect(bytes(join(dir, 'sketch.exe')).equals(bytes(launcherExe)), 'sketch.exe in the install folder is not the launcher');
    expect(!existsSync(join(dir, 'sketch-launcher.exe')) && !existsSync(join(dir, 'sketch-capture.exe')), 'Programs were left in the install folder');
    expect(bytes(join(dir, folder, 'sketch.exe')).equals(bytes(appExe)), `${folder}\\sketch.exe is not Sketch`);
    expect(bytes(join(dir, folder, 'sketch-capture.exe')).equals(bytes(helperExe)), `${folder}\\sketch-capture.exe is not the helper`);
    const stamp = readJson(join(dir, folder, 'version.json'));
    expect(stamp?.builtAt && stamp.commit, `version.json: ${JSON.stringify(stamp)}`);
    const cur = readJson(join(dir, 'current.json'));
    expect(cur?.folder === folder && cur.commit === stamp.commit, `current.json: ${JSON.stringify(cur)}`);
    // Installing the same build again, as a reinstall does.
    for (const [from, to] of [
      [appExe, 'sketch.exe'],
      [helperExe, 'sketch-capture.exe'],
      [launcherExe, 'sketch-launcher.exe'],
    ])
      cpSync(from, join(dir, to));
    runStep('layout');
    expect(bytes(join(dir, 'sketch.exe')).equals(bytes(launcherExe)) && bytes(join(dir, folder, 'sketch.exe')).equals(bytes(appExe)), 'A reinstall broke the layout');
    mkdirSync(join(dir, 'app-1234567'));
    writeFileSync(join(dir, 'app-1234567', 'sketch.exe'), 'older');
    mkdirSync(join(dir, '.trash-app-7654321'));
    runStep('remove');
    const left = readdirSync(dir);
    expect(!left.some((n) => n.startsWith('app-') || n.startsWith('.trash-') || n === 'current.json'), `Left after uninstalling: ${left.join(', ')}`);
  });

  await check('Through the launcher, Sketch opens the version current.json names, and points its pin, helper entry and helper at the launcher', async () => {
    mkdirSync(install);
    cpSync(launcherExe, launcher);
    makeVersion(`app-${short(base)}`, base);
    setCurrent(`app-${short(base)}`, base);
    // Capture keys, so Sketch starts its capture helper and writes the (stand-in) sign-in entry.
    writeFileSync(join(data, 'capture.json'), JSON.stringify({ keys: 'Ctrl+Alt+Shift+F11', after: 'notify', hide: false }));
    // Held back as if its build had failed, so the next check can use a stand-in build first.
    mkdirSync(join(data, 'build'), { recursive: true });
    writeFileSync(join(data, 'build', 'last-error.json'), JSON.stringify({ commit: pushed, error: 'held back by the check' }));
    let path;
    ({ app, path } = await viaLauncher());
    expect(same(path, join(install, `app-${short(base)}`, 'sketch.exe')), `Sketch runs from ${path}`);
    const relaunch = await app.evaluate(`window.__TAURI_INTERNALS__.invoke('test_relaunch_command')`);
    expect(relaunch === `"${launcher}"`, `Relaunch command: ${relaunch}`);
    await waitUntil('the capture helper', () => helpers().length === 1, 10_000);
    expect(same(helpers()[0], join(install, `app-${short(base)}`, 'sketch-capture.exe')), `Helper runs from ${helpers()[0]}`);
    const entry = readFileSync(join(data, 'run-entry.txt'), 'utf8');
    expect(entry === `"${launcher}" --capture-helper`, `Sign-in entry: ${entry}`);
    // The sign-in entry's command starts the current version's helper (none starts while one runs, so stop it first).
    ps(`Get-Process sketch-capture -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\*' } | Stop-Process -Force; exit 0`);
    await waitUntil('the helper to stop', () => helpers().length === 0, 5000);
    spawn(launcher, ['--capture-helper'], { stdio: 'ignore', cwd: work, env, detached: true }).unref();
    await waitUntil('the helper from the sign-in entry', () => helpers().length === 1, 10_000);
    expect(same(helpers()[0], join(install, `app-${short(base)}`, 'sketch-capture.exe')), `Helper runs from ${helpers()[0]}`);
  });

  await check("A build script's message makes Sketch check at once: its building spinner shows and goes within 2 s", async () => {
    const spinner = () => app.evaluate(`!!document.querySelector('.st-version .st-building')`);
    // Past the check 4 s after start; the next timed one is 5 minutes away.
    await sleep(6000);
    expect(!(await spinner()), 'A spinner shows with no build running');
    // A stand-in build of a commit git doesn't know, which counts as newer.
    const lock = join(data, 'build', 'build.lock');
    writeFileSync(lock, JSON.stringify({ commit: 'f'.repeat(40) }));
    expect(pingSketch(data), "The message didn't reach Sketch");
    await waitUntil('the spinner after the message', spinner, 2000);
    rmSync(lock);
    expect(pingSketch(data), "The second message didn't reach Sketch");
    await waitUntil('the spinner to go after the message', async () => !(await spinner()), 2000);
  });

  let stagedAt = 0;
  await check('A pushed commit is built in its own worktree and staged as a new version folder while Sketch keeps working, with nothing in the menu bar', async () => {
    // Let go of the build held back above; the next check (on focus) starts it.
    rmSync(join(data, 'build', 'last-error.json'));
    await app.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await waitUntil('the build to start', () => existsSync(join(data, 'build', 'build.lock')), 20_000);
    expect(!(await app.evaluate(`!!document.querySelector('.update-btn')`)), 'An update button shows in the menu bar');
    expect(!(await icon(app)), 'The update icon shows while the build runs');
    // The spinner by the version number shows instead, within the first check's reply.
    await waitUntil('the building spinner', () => app.evaluate(`(() => { const s = document.querySelector('.st-building'); return !!s && s.getAttribute('aria-label') === 'Update building' && s.parentElement.matches('.st-version'); })()`), 15_000);
    await waitUntil('current.json to name the pushed commit', () => current()?.commit === pushed, 25 * 60_000);
    stagedAt = Date.now();
    const folder = join(install, `app-${short(pushed)}`);
    expect(current().folder === `app-${short(pushed)}` && current().previous === `app-${short(base)}`, `current.json: ${JSON.stringify(current())}`);
    for (const f of ['sketch.exe', 'sketch-capture.exe', 'version.json']) expect(existsSync(join(folder, f)), `No ${f} in the new version folder`);
    expect(readJson(join(folder, 'version.json')).subject === 'Update check: a pushed change', 'version.json has no subject');
    expect(!readdirSync(install).some((n) => n.endsWith('.part')), 'A .part folder was left');
    const tree = join(data, 'build', 'sketch-update-build');
    expect(git(tree, 'rev-parse', 'HEAD') === pushed, 'The worktree is on another commit');
    expect(!existsSync(join(tree, rel, 'src', 'uncommitted.ts')), 'The uncommitted edit is in the build');
    expect((await app.evaluate('1 + 1')) === 2, "The running Sketch doesn't answer");
    expect(running().length === 1 && same(running()[0].path, join(install, `app-${short(base)}`, 'sketch.exe')), 'The running Sketch changed');
    expect(!(await app.evaluate(`!!document.querySelector('.update-btn')`)), 'An update button shows in the menu bar');
  }, 30 * 60_000);

  await check('The update ready icon shows within one check, in the status bar text colour, does nothing, and Restart to Update is in the Help menu', async () => {
    // No focus event: the 10-second check while building has to find it on its own.
    await waitUntil('the icon', async () => !!(await icon(app)), Math.max(1000, stagedAt + 15_000 - Date.now()));
    expect(!(await app.evaluate(`!!document.querySelector('.st-building')`)), 'The building spinner stayed with the icon');
    console.log(`      Icon ${((Date.now() - stagedAt) / 1000).toFixed(1)} s after staging`);
    const i = await icon(app);
    expect(i.role === 'img' && i.label === 'Update ready' && i.tip === null && i.svg, `Icon: ${JSON.stringify(i)}`);
    // The icon shares one spot with the version number.
    const spot = await app.evaluate(`document.querySelector('.st-update').parentElement.matches('.st-version') && document.querySelector('.st-version').textContent`);
    expect(/^v\d+\.\d+\.\d+$/.test(spot), `Version beside the icon: ${JSON.stringify(spot)}`);
    for (const dark of [false, true]) {
      const colours = await app.evaluate(`(() => {
        document.documentElement.classList.toggle('dark', ${dark});
        const i = getComputedStyle(document.querySelector('.st-update svg'));
        return { icon: i.color, stroke: i.stroke, bar: getComputedStyle(document.querySelector('.statusbar')).color, cursor: getComputedStyle(document.querySelector('.st-update')).cursor };
      })()`);
      expect(colours.icon === colours.bar && colours.stroke === colours.bar, `${dark ? 'Dark' : 'Light'}: icon ${colours.icon} / ${colours.stroke}, status bar ${colours.bar}`);
      expect(['auto', 'default'].includes(colours.cursor), `Cursor: ${colours.cursor}`);
    }
    await app.evaluate(`document.documentElement.classList.toggle('dark', matchMedia('(prefers-color-scheme: dark)').matches)`);
    const before = await app.state();
    await app.evaluate(`document.querySelector('.st-update').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
    await sleep(1500);
    const after = await app.state();
    expect(JSON.stringify(before) === JSON.stringify(after) && running().length === 1, 'Clicking the icon did something');
    const help = await app.evaluate(`(async () => {
      [...document.querySelectorAll('.menu-title')].find((b) => b.textContent === 'Help').click();
      await new Promise((r) => setTimeout(r, 200));
      const items = [...document.querySelectorAll('.menu-item')].map((m) => m.textContent);
      document.querySelector('.menu-title.open').click();
      return items;
    })()`);
    expect(help.some((t) => t.includes('Restart to Update')), `Help menu: ${help.join(', ')}`);
  });

  await check('Left idle in the background, Sketch restarts quietly into the new version with its windows and pictures as they were', async () => {
    // An unsaved picture in the first window, at a known place.
    const small = join(work, 'small.png');
    writeFileSync(small, png(300, 200));
    clipboard.image(small);
    await app.press('v', 2, ['paste']);
    await app.waitFor('the pasted picture', (s) => s.title === 'Untitled* - Sketch');
    const oldPid = running()[0].pid;
    let wins = windowsOf(oldPid);
    const main = wins.find((w) => w.title === 'Untitled* - Sketch');
    screen(work, `[SketchScreen]::Restore(${main.h}); [SketchScreen]::Place(${main.h}, 140, 110, 900, 640, $false)`);
    // A saved file opened from Explorer goes in a second tab (F14); the first tab shows again.
    const file = join(work, 'second.png');
    writeFileSync(file, png(120, 80));
    spawn(launcher, [file], { stdio: 'ignore', cwd: work, env, detached: true }).unref();
    await app.waitFor('the second tab', (s) => s.tabs === 2 && s.title === 'second.png - Sketch', 15_000);
    await app.evaluate(`window.sketch.run('tab.prev')`);
    await app.waitFor('the first tab', (s) => s.title === 'Untitled* - Sketch');
    // A second window with another saved file, minimised.
    const third = join(work, 'third.png');
    writeFileSync(third, png(90, 60));
    await app.evaluate(`window.__TAURI_INTERNALS__.invoke('open_window', { launch: { file: ${JSON.stringify(third)}, paste: false, recover: null, capture: null, capturing: false, quick: false, restart: null, hidden: false } })`);
    await waitUntil('the second window', () => windowsOf(oldPid).some((w) => w.title === 'third.png - Sketch' && w.visible), 15_000);
    const second = windowsOf(oldPid).find((w) => w.title === 'third.png - Sketch');
    screen(work, `[SketchScreen]::Minimize(${second.h})`);
    await sleep(3500); // Autosave runs 3 s after a change.
    const bounds = screen(work, `[SketchScreen]::Bounds(${main.h})`);
    // A version folder older than the previous one, which the launcher removes on the restart.
    makeVersion('app-0000000', base, '2020-01-01T00:00:00.000Z');
    // Another window in front, then a short idle time.
    target = await captureTarget(work, 1100, 120, 260, 200);
    await waitUntil('the other window in front', () => !sketchInFront(oldPid), 10_000).catch(() => {
      throw new Error('Sketch kept the focus, so it has no reason to restart quietly');
    });
    writeFileSync(join(data, 'idle-seconds.txt'), '2');
    console.log('      Waiting for 2 s with no keyboard or mouse input...');
    await waitUntil('the old Sketch to close', () => !running().some((r) => r.pid === oldPid), 3 * 60_000);
    holdQuietRestart();
    const startedAt = new Date().toISOString();
    await app.quit(1000);
    let path;
    ({ app, path } = await attachNew(oldPid, 30_000));
    expect(same(path, join(install, `app-${short(pushed)}`, 'sketch.exe')), `The new Sketch runs from ${path}`);
    const pid = running()[0].pid;
    await waitUntil('both windows back', () => windowsOf(pid).filter((w) => w.visible).length === 2, 20_000);
    wins = windowsOf(pid);
    const newMain = wins.find((w) => w.title === 'Untitled* - Sketch');
    const newSecond = wins.find((w) => w.title === 'third.png - Sketch');
    expect(newMain && newSecond, `Windows: ${JSON.stringify(wins)}`);
    expect(!newMain.iconic && newSecond.iconic, `Minimised: main ${newMain.iconic}, second ${newSecond.iconic}`);
    const newBounds = screen(work, `[SketchScreen]::Bounds(${newMain.h})`);
    expect(newBounds === bounds, `The window was at ${bounds}, now ${newBounds}`);
    const front = () => {
      const h = Number(screen(work, '[SketchScreen]::Foreground()'));
      return windowsOf(pid).find((w) => w.h === h)?.title ?? h;
    };
    expect(!sketchInFront(pid), `The restarted Sketch took the focus: ${front()} is in front`);
    // Each window's tabs came back together: the slots are rewritten as the new windows' a few seconds after.
    await waitUntil('the slots rewritten by the new windows', () => {
      const metas = readdirSync(join(data, 'recovery')).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(readFileSync(join(data, 'recovery', n), 'utf8')));
      const groupOf = (name) => metas.find((m) => m.file.name === name)?.group;
      return metas.length === 3 && groupOf('Untitled') && groupOf('Untitled') === groupOf('second.png') && groupOf('third.png') !== groupOf('Untitled') && metas.every((m) => m.savedAt > startedAt);
    }, 15_000);
    await sleep(1500);
    const toasts = (await app.windowTitles()).length && (await app.evaluate(`document.querySelector('.toast')?.textContent ?? null`));
    expect(!toasts, `A message showed: ${toasts}`);
    const relaunch = await app.evaluate(`window.__TAURI_INTERNALS__.invoke('test_relaunch_command')`);
    expect(relaunch === `"${launcher}"`, `Relaunch command: ${relaunch}`);
    const folders = readdirSync(install).filter((n) => n.startsWith('app-')).sort();
    expect(JSON.stringify(folders) === JSON.stringify([`app-${short(base)}`, `app-${short(pushed)}`].sort()), `Version folders: ${folders.join(', ')}; current.json: ${JSON.stringify(current())}`);
    await waitUntil("the new version's capture helper", () => helpers().length === 1 && same(helpers()[0], join(install, `app-${short(pushed)}`, 'sketch-capture.exe')), 10_000);
    await app.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await sleep(4000);
    expect(!(await icon(app)), 'The update icon shows on the new version');
    target.child.kill();
    target = null;
  });

  await check('Restart to Update restarts into the version current.json names, with the windows back in front', async () => {
    // A newer version, staged by hand: a copy of this build stamped with a commit after it. Its own
    // build is marked failed, so the app doesn't build it for real.
    git(clone, 'checkout', '-q', '--detach', pushed);
    writeFileSync(join(clone, rel, 'README.md'), readFileSync(join(clone, rel, 'README.md'), 'utf8') + '\n<!-- second -->\n');
    const next = commitIn(clone, 'Update check: another change');
    writeFileSync(join(data, 'build', 'last-error.json'), JSON.stringify({ commit: next, error: 'not built by the check' }));
    const pushedDir = join(install, `app-${short(pushed)}`);
    makeVersion(`app-${short(next)}`, next, new Date().toISOString(), { app: join(pushedDir, 'sketch.exe'), helper: join(pushedDir, 'sketch-capture.exe') });
    setCurrent(`app-${short(next)}`, next, `app-${short(pushed)}`);
    await app.evaluate(`window.dispatchEvent(new Event('focus'))`);
    await waitUntil('the icon', async () => !!(await icon(app)), 15_000);
    const oldPid = running()[0].pid;
    await app.evaluate(`window.sketch.run('app.update')`).catch(() => {});
    await waitUntil('the old Sketch to close', () => !running().some((r) => r.pid === oldPid), 30_000);
    await app.quit(1000);
    let path;
    ({ app, path } = await attachNew(oldPid, 30_000));
    expect(same(path, join(install, `app-${short(next)}`, 'sketch.exe')), `The new Sketch runs from ${path}`);
    const pid = running()[0].pid;
    await waitUntil('both windows back', () => windowsOf(pid).filter((w) => w.visible).length === 2, 20_000);
    const titles = windowsOf(pid).map((w) => w.title).sort();
    expect(JSON.stringify(titles) === JSON.stringify(['Untitled* - Sketch', 'third.png - Sketch'].sort()), `Windows: ${titles.join(', ')}`);
  });

  await check('The launcher never starts a half-copied folder, and falls back to the newest other version when the current one is missing', async () => {
    await app.quit(0);
    app = null;
    ps(`Get-Process sketch, sketch-capture -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\*' } | Stop-Process -Force; exit 0`);
    await waitUntil('Sketch to stop', () => running().length === 0, 10_000);
    rmSync(join(data, 'recovery'), { recursive: true, force: true });
    const cur = current();
    // A copy in progress (newest of all) beside the current version: the launcher passes it over.
    mkdirSync(join(install, 'app-fffffff.part'));
    cpSync(appExe, join(install, 'app-fffffff.part', 'sketch.exe'));
    let path;
    ({ app, path } = await viaLauncher());
    expect(same(path, join(install, cur.folder, 'sketch.exe')), `Started ${path}`);
    await app.quit(0);
    await waitUntil('Sketch to stop', () => running().length === 0, 10_000);
    // current.json names a folder that's gone: the newest other one starts, and says so.
    setCurrent('app-missing', 'missing', cur.folder);
    ({ app, path } = await viaLauncher());
    expect(same(path, join(install, cur.folder, 'sketch.exe')), `Fell back to ${path}`);
    await app.waitFor('the fallback message', (s) => /couldn't open its newest version/.test(s.toast ?? ''), 10_000);
    await app.quit(0);
    app = null;
    await waitUntil('Sketch to stop', () => running().length === 0, 10_000);
    setCurrent(cur.folder, cur.commit, cur.previous);
  });

  await check('Start-up through the launcher stays within the speed budget', async () => {
    const time = (exe) => {
      const r = spawnSync(process.execPath, [join(sketchDir, 'scripts', 'startup-check.mjs'), exe], { encoding: 'utf8', env: { ...process.env, SKETCH_UPDATE_REPO: clone } });
      const median = /median (\d+) ms/.exec(r.stdout)?.[1];
      expect(median, `startup-check failed:\n${r.stdout}${r.stderr}`);
      return { median: Number(median), ok: r.status === 0 };
    };
    const direct = time(join(install, current().folder, 'sketch.exe'));
    const through = time(launcher);
    console.log(`      Median start-up: ${direct.median} ms straight, ${through.median} ms through the launcher`);
    expect(through.ok, `Over budget through the launcher: ${through.median} ms`);
  });
} catch {
  // Reported above.
} finally {
  await app?.quit();
  target?.child.kill();
  ps(`Get-Process sketch, sketch-capture -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\*' } | Stop-Process -Force; exit 0`);
  await sleep(500);
  // The build worktree is registered in the clone, which goes with the folder.
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {}
}

clearInterval(keepAlive);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} update checks passed.`);
if (failed || !results.length) process.exit(1);
