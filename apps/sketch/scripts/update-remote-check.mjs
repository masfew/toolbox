// Checks Updates on Every Machine (F16) end to end, in scratch install folders laid out as the
// installer lays them out, so nothing touches the installed Sketch or this clone. Run by
// `npm run check:update` after scripts/update-check.mjs.
//  1. Clone installs (F16.2): the clone's origin is a local bare repo that a second clone pushes to.
//     A push reaches the install within one (shortened) fetch and its build starts within seconds;
//     a commit outside Sketch's folder moves origin/main but starts no build; the person's branch and
//     uncommitted files are untouched; a broken origin is logged once per run of failures and the
//     app shows nothing; with Sketch closed, the capture helper fetches and starts the build itself;
//     and a release install's leftover download is cleared.
//  2. Release installs (F16.5): a release-channel build (signed with a key made for the check)
//     reads latest.json from a local server. An equal build, a bad signature, a tampered zip and a
//     cut-off download are all refused and leave nothing behind; a newer release downloads with the
//     spinner showing, is staged as a version folder (current.json names it) and the ready icon
//     shows; with Sketch closed, the capture helper downloads the next one; and a clone install's
//     leftover build worktree is cleared. release-files.mjs writes the first latest.json.
// Usage: node scripts/update-remote-check.mjs
//
// Needs this checkout's release build (npm run tauri build -- --no-bundle). It also builds a
// release-channel copy into src-tauri/target/release-channel (5 to 15 minutes the first time, then
// about 2) and puts src-tauri/stamp.json back afterwards. Builds the clone install starts are stopped
// as soon as they're seen. Windows only.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { unzipSync, zipSync } from 'fflate';
import { buildInfo } from './build-info.mjs';
import { attach, ps, sleep } from './native-driver.mjs';

const sketchDir = resolve('.');
const repo = execFileSync('git', ['-C', sketchDir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const rel = execFileSync('git', ['-C', sketchDir, 'rev-parse', '--show-prefix'], { encoding: 'utf8' }).trim().replace(/\/$/, '') || '.';
const exesIn = (dir) => ['sketch.exe', 'sketch-capture.exe', 'sketch-launcher.exe'].map((f) => join(dir, f));
const sourceExes = exesIn(join(sketchDir, 'src-tauri', 'target', 'release'));
if (sourceExes.some((f) => !existsSync(f))) {
  console.error('Build the app first with: npm run tauri build -- --no-bundle');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'sketch-remote-'));
// The release-channel build rewrites src-tauri/stamp.json; the normal build's goes back at the end.
const stampFile = join(sketchDir, 'src-tauri', 'stamp.json');
const stampBefore = existsSync(stampFile) ? readFileSync(stampFile) : null;
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Update check', GIT_AUTHOR_EMAIL: 'check@example.com', GIT_COMMITTER_NAME: 'Update check', GIT_COMMITTER_EMAIL: 'check@example.com' };
/** Commits an edit to `file` (inside the clone) and pushes it to the bare origin; returns the commit. */
function pushEdit(cwd, file, message) {
  mkdirSync(join(cwd, file, '..'), { recursive: true });
  writeFileSync(join(cwd, file), `${existsSync(join(cwd, file)) ? readFileSync(join(cwd, file), 'utf8') : ''}\n<!-- ${message} -->\n`);
  execFileSync('git', ['-C', cwd, 'add', file], { stdio: 'ignore' });
  execFileSync('git', ['-C', cwd, 'commit', '-q', '-m', message], { stdio: 'ignore', env: gitEnv });
  execFileSync('git', ['-C', cwd, 'push', '-q', 'origin', 'HEAD:main'], { stdio: 'ignore', env: gitEnv });
  return git(cwd, 'rev-parse', 'HEAD');
}
const short = (c) => c.slice(0, 7);

const results = [];
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
async function check(name, fn, ms = 5 * 60_000) {
  try {
    let timer;
    await Promise.race([fn(), new Promise((_, fail) => (timer = setTimeout(() => fail(new Error(`The step took over ${ms / 60_000} minutes`)), ms)))]).finally(() => clearTimeout(timer));
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}
const waitUntil = async (what, test, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await test()) return;
    await sleep(250);
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
const logLines = (data, text) => (existsSync(join(data, 'build', 'build.log')) ? readFileSync(join(data, 'build', 'build.log'), 'utf8').split('\n').filter((l) => l.includes(text)).length : 0);

const port = 9300 + Math.floor(Math.random() * 600);
const mouseSpeed = join(work, 'mouse-speed.txt');
writeFileSync(mouseSpeed, '10');
const baseEnv = {
  ...process.env,
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port} --remote-debugging-address=127.0.0.1`,
  WEBVIEW2_USER_DATA_FOLDER: join(work, 'webview'),
  SKETCH_TEST_HOOKS: '1',
  SKETCH_TEST_MOUSE_SPEED: mouseSpeed,
};

/** An install folder as the installer leaves it, running `exes`' Sketch as version `commit`. */
function makeInstall(name, exes, commit) {
  const install = join(work, name);
  const [app, helper, launcher] = exes;
  const folder = join(install, `app-${short(commit)}`);
  mkdirSync(folder, { recursive: true });
  cpSync(launcher, join(install, 'sketch.exe'));
  cpSync(app, join(folder, 'sketch.exe'));
  cpSync(helper, join(folder, 'sketch-capture.exe'));
  writeFileSync(join(folder, 'version.json'), JSON.stringify({ builtAt: new Date().toISOString(), commit }));
  writeFileSync(join(install, 'current.json'), JSON.stringify({ folder: `app-${short(commit)}`, commit, previous: '' }));
  return install;
}

/** A data folder with quick fetches, the quiet restart held back, and capture keys so the helper runs. */
function makeData(name) {
  const data = join(work, name);
  mkdirSync(join(data, 'build'), { recursive: true });
  writeFileSync(join(data, 'fetch-seconds.txt'), '2');
  writeFileSync(join(data, 'idle-seconds.txt'), '86400');
  writeFileSync(join(data, 'capture.json'), JSON.stringify({ keys: 'Ctrl+Alt+Shift+F11', after: 'notify', hide: false }));
  return data;
}

const running = (install) =>
  ps(`Get-Process sketch -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\app-*' } | ForEach-Object { $_.Id }; exit 0`)
    .split(/\r?\n/)
    .filter(Boolean)
    .map(Number);
const helpers = (install) => ps(`Get-Process sketch-capture -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\*' } | ForEach-Object { $_.Id }; exit 0`).split(/\r?\n/).filter(Boolean);
const stopAll = (install) => ps(`Get-Process sketch, sketch-capture -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${install}\\*' } | Stop-Process -Force; exit 0`);

async function start(install, env) {
  const before = new Set(running(install));
  spawn(join(install, 'sketch.exe'), [], { stdio: 'ignore', cwd: work, env, detached: true }).unref();
  let pid;
  await waitUntil('Sketch to start through the launcher', () => (pid = running(install).find((p) => !before.has(p))), 20_000);
  return attach(port, pid);
}

/** Stops update builds the clone install started (the node script and everything under it), and holds `commit` back. */
function stopBuilds(data, commit) {
  ps(`Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*update-build.mjs*' -and $_.CommandLine -like '*${work}*' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F | Out-Null }; exit 0`);
  rmSync(join(data, 'build', 'build.lock'), { force: true });
  writeFileSync(join(data, 'build', 'last-error.json'), JSON.stringify({ commit, error: 'stopped by the check' }));
}
const lockCommit = (data) => readJson(join(data, 'build', 'build.lock'))?.commit;
const toast = (app) => app.evaluate(`document.querySelector('.toast')?.textContent ?? null`);

const keepAlive = setInterval(() => {}, 1000);
let app;
let server;
const installs = [];
try {
  // ---------- 1. Clone installs fetch new commits ----------
  // The commit the app under test was built from, which is HEAD unless someone has committed since.
  const head = readJson(join(sketchDir, 'src-tauri', 'stamp.json'))?.commit || git(repo, 'rev-parse', 'HEAD');
  const origin = join(work, 'origin.git');
  const clone = join(work, 'clone');
  const pusher = join(work, 'pusher');
  execFileSync('git', ['init', '-q', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' });
  // A fetch into the bare repo, not a push from this clone, which would run its pre-push hook.
  execFileSync('git', ['-C', origin, 'fetch', '-q', '--no-tags', repo, `${head}:refs/heads/main`], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', origin, clone], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', origin, pusher], { stdio: 'ignore' });
  // The person's own work in the clone: a branch and an uncommitted file.
  git(clone, 'switch', '-q', '-c', 'my-work');
  writeFileSync(join(clone, rel, 'my-notes.txt'), 'not committed\n');
  const cloneHead = git(clone, 'rev-parse', 'HEAD');

  const install = makeInstall('install-clone', sourceExes, head);
  installs.push(install);
  const data = makeData('data-clone');
  // A release install's half-done download, from before this install was built from a clone.
  mkdirSync(join(data, 'build', 'download'), { recursive: true });
  writeFileSync(join(data, 'build', 'download', 'app.zip'), 'leftover');
  const env = { ...baseEnv, SKETCH_DATA_DIR: data, SKETCH_UPDATE_REPO: clone };
  console.log(`Clone install at ${install}, running ${short(head)}`);
  app = await start(install, env);

  await check('A commit pushed from another clone reaches the install within one fetch, and its build starts within seconds', async () => {
    await waitUntil("the release install's leftover download to be cleared", () => !existsSync(join(data, 'build', 'download')), 10_000);
    await sleep(3000);
    const pushed = pushEdit(pusher, `${rel}/README.md`, 'Remote check: a pushed change');
    const t0 = Date.now();
    await waitUntil('the build of the pushed commit', () => lockCommit(data) === pushed, 30_000);
    console.log(`      Build started ${((Date.now() - t0) / 1000).toFixed(1)} s after the push`);
    expect(git(clone, 'rev-parse', 'refs/remotes/origin/main') === pushed, "origin/main didn't move");
    stopBuilds(data, pushed);
  });

  await check("A commit outside Sketch's folder moves origin/main but starts no build", async () => {
    const other = pushEdit(pusher, 'some-other-tool/README.md', 'Remote check: another tool');
    await waitUntil('origin/main to move', () => git(clone, 'rev-parse', 'refs/remotes/origin/main') === other, 20_000);
    await app.evaluate(`window.dispatchEvent(new Event('focus'))`);
    for (let i = 0; i < 20; i++) {
      expect(!existsSync(join(data, 'build', 'build.lock')), `A build started: ${JSON.stringify(readJson(join(data, 'build', 'build.lock')))}`);
      await sleep(300);
    }
  });

  await check("The person's branch, checkout and uncommitted files are untouched", async () => {
    expect(git(clone, 'symbolic-ref', '--short', 'HEAD') === 'my-work', `Branch: ${git(clone, 'symbolic-ref', '--short', 'HEAD')}`);
    expect(git(clone, 'rev-parse', 'HEAD') === cloneHead, 'The checkout moved');
    expect(readFileSync(join(clone, rel, 'my-notes.txt'), 'utf8') === 'not committed\n', 'The uncommitted file changed');
    expect(git(clone, 'status', '--porcelain').includes('my-notes.txt'), 'The uncommitted file is no longer uncommitted');
  });

  await check('A broken origin is logged once per run of failures and once when it works again, and the app shows nothing', async () => {
    git(clone, 'remote', 'set-url', 'origin', join(work, 'missing.git'));
    await waitUntil('the failure in build.log', () => logLines(data, "Couldn't fetch origin/main") === 1, 15_000);
    await sleep(7000); // Three more failed fetches.
    expect(logLines(data, "Couldn't fetch origin/main") === 1, `${logLines(data, "Couldn't fetch origin/main")} failure lines`);
    expect(!(await toast(app)), `A message showed: ${await toast(app)}`);
    git(clone, 'remote', 'set-url', 'origin', origin);
    await waitUntil('the "works again" line', () => logLines(data, 'Fetching origin/main works again') === 1, 15_000);
  });

  await check('With Sketch closed, the capture helper fetches and starts the build itself', async () => {
    await waitUntil('the capture helper', () => helpers(install).length === 1, 10_000);
    await app.quit(1000);
    app = null;
    await waitUntil('Sketch to close', () => running(install).length === 0, 15_000);
    expect(helpers(install).length === 1, 'The helper closed with Sketch');
    const pushed = pushEdit(pusher, `${rel}/README.md`, 'Remote check: pushed while closed');
    await waitUntil("the helper's build of the pushed commit", () => lockCommit(data) === pushed, 30_000);
    stopBuilds(data, pushed);
  });
  stopAll(install);

  // ---------- 2. Release installs download new releases ----------
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const other = generateKeyPairSync('ed25519').privateKey;
  const targetDir = join(sketchDir, 'src-tauri', 'target', 'release-channel');
  const releaseEnv = { ...process.env, SKETCH_RELEASE: '1', SKETCH_UPDATE_KEY: pem, GITHUB_REPOSITORY: 'example/sketch-check', CARGO_TARGET_DIR: targetDir };
  console.log(`Building a release-channel copy in ${targetDir}...`);
  const built = spawnSync('npm run tauri -- build --no-bundle', { cwd: sketchDir, env: releaseEnv, shell: true, encoding: 'utf8', timeout: 40 * 60_000 });
  expect(built.status === 0, `The release-channel build failed:\n${(built.stdout + built.stderr).slice(-3000)}`);
  const releaseExes = exesIn(join(targetDir, 'release'));
  const me = buildInfo();
  const dist = join(work, 'dist');
  const files = new Map();
  let latest = null;
  let lastFile = null;
  server = createServer((req, res) => {
    if (req.url === '/releases/download/sketch-latest/latest.json' && latest) return res.end(latest);
    const file = files.get(decodeURIComponent(req.url.replace(/^\/files\//, '')));
    if (!file) return res.writeHead(404).end();
    file.hits++;
    res.writeHead(200, { 'Content-Length': file.data.length });
    if (file.mode === 'cut') return res.write(file.data.subarray(0, file.data.length >> 1), () => res.destroy());
    if (file.mode !== 'slow') return res.end(file.data);
    // Ten pieces over about 4 s, so the spinner has time to show.
    let i = 0;
    const step = Math.ceil(file.data.length / 10);
    const next = () => (i * step >= file.data.length ? res.end() : res.write(file.data.subarray(i * step, ++i * step), () => setTimeout(next, 400)));
    next();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrote = spawnSync(process.execPath, ['scripts/release-files.mjs', dist], { cwd: sketchDir, env: { ...releaseEnv, SKETCH_DOWNLOAD_BASE: `${base}/files/` }, encoding: 'utf8' });
  expect(wrote.status === 0 && existsSync(join(dist, 'latest.json')), `release-files.mjs failed:\n${wrote.stdout}${wrote.stderr}`);
  const realZip = readFileSync(readdirSync(dist).filter((f) => f.endsWith('-app.zip')).map((f) => join(dist, f))[0]);

  /** A release of the same programs stamped as `build` and `commit`, and its latest.json (signed with `key`). */
  function release(build, commit, { key = privateKey, mode = 'normal', tamper = false } = {}) {
    const entries = unzipSync(realZip);
    entries['version.json'] = new TextEncoder().encode(JSON.stringify({ builtAt: new Date().toISOString(), commit, subject: `Release check ${build}`, build, version: `9.9.${build}` }));
    const zip = Buffer.from(zipSync(entries));
    const name = `sketch-${build}-${mode}${tamper ? '-tampered' : ''}.zip`;
    const served = tamper ? Buffer.concat([zip.subarray(0, zip.length - 1), Buffer.from([zip[zip.length - 1] ^ 1])]) : zip;
    files.set(name, { data: served, mode, hits: 0 });
    const signed = JSON.stringify({ version: `9.9.${build}`, build, commit, url: `${base}/files/${name}`, size: zip.length, sha512: createHash('sha512').update(zip).digest('hex') });
    lastFile = files.get(name);
    return JSON.stringify({ signed, signature: sign(null, Buffer.from(signed), key).toString('hex') });
  }

  const rInstall = makeInstall('install-release', releaseExes, me.commit);
  installs.push(rInstall);
  const rData = makeData('data-release');
  // A clone install's build worktree, from before this install came from a release.
  mkdirSync(join(rData, 'build', 'sketch-update-build', 'apps'), { recursive: true });
  const rEnv = { ...baseEnv, SKETCH_DATA_DIR: rData, SKETCH_RELEASES_URL: `${base}/releases` };
  const first = `app-${short(me.commit)}`;
  const folders = () => readdirSync(rInstall).filter((n) => n.startsWith('app-')).sort();
  const nothingLeft = () => JSON.stringify(folders()) === JSON.stringify([first]) && !existsSync(join(rData, 'build', 'download')) && readJson(join(rInstall, 'current.json'))?.folder === first;
  const refocus = () => app.evaluate(`window.dispatchEvent(new Event('focus'))`);
  latest = readFileSync(join(dist, 'latest.json'), 'utf8');
  console.log(`Release install at ${rInstall}, running build ${me.build}; serving latest.json at ${base}`);
  app = await start(rInstall, rEnv);

  await check('A release no newer than the running one, a bad signature, a tampered zip and a cut-off download are all refused and leave nothing behind', async () => {
    await waitUntil("the clone install's leftover worktree to be cleared", () => !existsSync(join(rData, 'build', 'sketch-update-build')), 10_000);
    const watchNoLock = async (ms) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) expect(!existsSync(join(rData, 'build', 'build.lock')), 'A download started');
    };
    // release-files.mjs's own latest.json names this very build.
    await refocus();
    await watchNoLock(4000);
    expect(nothingLeft(), `After an equal build: ${folders().join(', ')}`);
    latest = release(me.build + 1, 'a1'.repeat(20), { key: other });
    await sleep(2500);
    await refocus();
    await watchNoLock(4000);
    expect(nothingLeft() && logLines(rData, "Couldn't read the latest release") === 1, `After a bad signature: ${folders().join(', ')}; ${logLines(rData, "Couldn't read the latest release")} log lines`);
    for (const opts of [{ tamper: true }, { mode: 'cut' }]) {
      latest = release(me.build + 1, 'a1'.repeat(20), opts);
      await sleep(2500);
      await refocus();
      await waitUntil(`the ${opts.tamper ? 'tampered' : 'cut-off'} download to be tried`, () => lastFile.hits > 0, 15_000);
      await waitUntil('the download to finish', () => !existsSync(join(rData, 'build', 'build.lock')), 15_000);
      expect(nothingLeft(), `After a ${opts.tamper ? 'tampered' : 'cut-off'} download: ${folders().join(', ')}; ${JSON.stringify(readJson(join(rInstall, 'current.json')))}`);
    }
    expect(logLines(rData, "Couldn't download") === 1, `${logLines(rData, "Couldn't download")} download failure lines`);
    expect(!(await toast(app)), `A message showed: ${await toast(app)}`);
  });

  const fakeA = 'a1'.repeat(20);
  await check('A newer release downloads with the spinner showing, is staged as a version folder, and the ready icon shows', async () => {
    latest = release(me.build + 1, fakeA, { mode: 'slow' });
    await sleep(2500);
    await refocus();
    await waitUntil('the building spinner', () => app.evaluate(`!!document.querySelector('.st-version .st-building')`), 10_000);
    await waitUntil('current.json to name the release', () => readJson(join(rInstall, 'current.json'))?.folder === `app-${short(fakeA)}`, 30_000);
    const cur = readJson(join(rInstall, 'current.json'));
    expect(cur.commit === fakeA && cur.previous === first, `current.json: ${JSON.stringify(cur)}`);
    const folder = join(rInstall, `app-${short(fakeA)}`);
    for (const f of ['sketch.exe', 'sketch-capture.exe', 'version.json']) expect(existsSync(join(folder, f)), `No ${f} in the new version folder`);
    expect(!existsSync(join(folder, 'sketch-launcher.exe')), 'The launcher was left in the version folder');
    expect(readFileSync(join(rInstall, 'sketch.exe')).equals(readFileSync(releaseExes[2])), 'The launcher changed');
    const t0 = Date.now();
    await waitUntil('the update ready icon', () => app.evaluate(`!!document.querySelector('.st-update')`), 15_000);
    console.log(`      Icon ${((Date.now() - t0) / 1000).toFixed(1)} s after staging`);
    expect(!(await app.evaluate(`!!document.querySelector('.st-building')`)), 'The spinner stayed with the icon');
    expect(logLines(rData, 'Staged Sketch 9.9.') === 1 && logLines(rData, 'Downloading updates works again') === 1, 'build.log is missing the staging or the recovery line');
  });

  await check('With Sketch closed, the capture helper downloads and stages the next release', async () => {
    await waitUntil('the capture helper', () => helpers(rInstall).length === 1, 10_000);
    await app.quit(1000);
    app = null;
    await waitUntil('Sketch to close', () => running(rInstall).length === 0, 15_000);
    const fakeB = 'b2'.repeat(20);
    latest = release(me.build + 2, fakeB);
    await waitUntil("the helper's download to be staged", () => readJson(join(rInstall, 'current.json'))?.folder === `app-${short(fakeB)}`, 30_000);
    // The first version folder stays while the helper runs from it; the next start of Sketch replaces the helper.
    expect(readJson(join(rInstall, 'current.json')).previous === `app-${short(fakeA)}`, `current.json: ${JSON.stringify(readJson(join(rInstall, 'current.json')))}`);
  });
} catch (e) {
  results.push(false);
  console.log(`FAIL  ${e.message}`);
} finally {
  await app?.quit().catch(() => {});
  server?.close();
  for (const install of installs) stopAll(install);
  // The normal build's stamp, so it still says which commit target/release was built from.
  if (stampBefore) writeFileSync(stampFile, stampBefore);
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {}
}

clearInterval(keepAlive);
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} remote update checks passed.`);
if (failed || !results.length) process.exit(1);
