// Developer updates: after a push to main lands, builds the pushed Sketch into the installed copy in
// the background, so the next start of Sketch is already the new version. It's the in-app updater's
// own build (src-tauri/src/update.rs and update-build.mjs, F6), started by the push instead of by a
// running Sketch: the same worktree, lock, log and staging, so the two never build at once, and an
// open Sketch sees the staged version and shows its update icon as usual. Nothing here ships in the
// app or its installer; it runs only for whoever turns the repo's git hooks on.
//
// Usage (from Sketch's folder):
//   npm run dev:hooks        turn on the repo's git hooks (the folder at the repo's root whose pre-push runs
//                            this script: .github/hooks in the toolbox repo), once per clone
//   npm run dev:update       build the newest pushed Sketch into the installed copy now (it also retries a failed build)
// The pre-push hook runs `node <tool>/scripts/dev-update.mjs --after <commit being pushed to main>`.
//
// The work runs in a process started through WMI (Win32_Process.Create), hidden, which outlives the
// push and the terminal. That also takes it outside the Claude desktop app's package, which would
// otherwise redirect every write to AppData into its own copy (see CLAUDE.md), so a push from a
// Claude Code session in that app updates the real install. Its messages go to dev-update.log in the
// build folder; the build's own output goes to build.log there, as for the in-app updater.
//
// Options for checks: --install <dir> (default %LOCALAPPDATA%\Sketch), --data-dir <dir> (default
// %LOCALAPPDATA%\app.sketch.desktop), --repo <dir> (default this checkout's main repo), --path <folder>
// (Sketch's folder in it, default where this script sits), --ref <ref>
// (default refs/remotes/origin/main), --wait <seconds> (how long to wait for the push, default 300),
// --here (do the work in this process, in the foreground).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pingSketch } from './ping-sketch.mjs';

const self = fileURLToPath(import.meta.url);
const sketchDir = resolve(dirname(self), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

// The in-app updater's names (update.rs).
const WORKTREE = 'sketch-update-build';
const LOCK_STALE_MS = 90_000;

const git = (cwd, ...a) => {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
};
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (flag('hooks')) {
  // Points this clone at the repo's hooks folder (the one whose pre-push runs dev-update.mjs), unless
  // it already uses hooks of its own.
  const top = git(sketchDir, 'rev-parse', '--show-toplevel');
  const runsUs = (folder) => {
    try {
      return readFileSync(join(top, folder, 'pre-push'), 'utf8').includes('dev-update.mjs');
    } catch {
      return false;
    }
  };
  const ours = ['.github/hooks', '.githooks'].find(runsUs);
  const now = git(sketchDir, 'config', '--get', 'core.hooksPath');
  if (now && runsUs(now)) {
    console.log(`Git hooks are already on (core.hooksPath = ${now}): after each push to main, the installed Sketch is updated in the background.`);
    process.exit(0);
  }
  if (!ours) {
    console.error(`No hooks folder at ${top} runs dev-update.mjs on a push. Run \`npm run dev:update\` after each push instead.`);
    process.exit(1);
  }
  if (now) {
    console.error(`This clone already uses its own git hooks (core.hooksPath = ${now}), so it was left alone. Run ${ours}/pre-push from your own hook instead.`);
    process.exit(1);
  }
  execFileSync('git', ['-C', top, 'config', 'core.hooksPath', ours]);
  console.log('Git hooks are on: after each push to main, the installed Sketch is updated in the background.');
  process.exit(0);
}

if (!flag('here') && !flag('worker')) {
  // Starts the work outside this process tree and returns at once, so the push never waits for it.
  const passOn = args.filter((a) => a !== '--here');
  const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  const commandLine = [process.execPath, self, '--worker', ...passOn].map(quote).join(' ');
  const script =
    '$si = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0 }; ' +
    '$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:SKETCH_DEV_UPDATE_CMD; CurrentDirectory = $env:SKETCH_DEV_UPDATE_DIR; ProcessStartupInformation = $si }; ' +
    'exit $r.ReturnValue';
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, SKETCH_DEV_UPDATE_CMD: commandLine, SKETCH_DEV_UPDATE_DIR: sketchDir },
    stdio: 'ignore',
    windowsHide: true,
  });
  if (r.status !== 0) {
    console.error(`Sketch dev update: couldn't start the background update (${r.status ?? r.error?.message}).`);
    process.exit(0);
  }
  const data = opt('data-dir') ?? join(process.env.LOCALAPPDATA ?? '', 'app.sketch.desktop');
  console.log(`Sketch dev update: the installed Sketch will be updated in the background once the push lands (log: ${join(data, 'build', 'dev-update.log')}).`);
  process.exit(0);
}

// ---------- The work ----------

const install = resolve(opt('install') ?? join(process.env.LOCALAPPDATA ?? '', 'Sketch'));
const data = resolve(opt('data-dir') ?? join(process.env.LOCALAPPDATA ?? '', 'app.sketch.desktop'));
const ref = opt('ref') ?? 'refs/remotes/origin/main';
const after = opt('after');
const buildDir = join(data, 'build');
mkdirSync(buildDir, { recursive: true });
const logFile = join(buildDir, 'dev-update.log');
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}`;
  if (flag('here')) console.log(line);
  try {
    appendFileSync(logFile, `${line}\n`);
  } catch {}
};
// The main repo, also when this runs from a git worktree of it: the build worktree is the main repo's.
const common = git(sketchDir, 'rev-parse', '--path-format=absolute', '--git-common-dir');
const repo = resolve(opt('repo') ?? (common ? dirname(common) : resolve(sketchDir, '..')));
// Sketch's folder inside the repo (`apps/sketch`; empty when it's the repo's root), as the build stamp records it.
const path = opt('path') ?? (git(sketchDir, 'rev-parse', '--show-prefix') ?? '').replace(/\/$/, '');
const pathspec = path || '.';

const lockPath = join(buildDir, 'build.lock');
const lockAlive = () => {
  try {
    return Date.now() - statSync(lockPath).mtimeMs < LOCK_STALE_MS;
  } catch {
    return false;
  }
};

/** The in-app updater's start_build, waiting for the build instead of leaving it running. */
function build(commit) {
  const src = join(buildDir, WORKTREE);
  const run = (...a) => {
    const r = spawnSync('git', a, { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) throw new Error((r.stderr || `git ${a.join(' ')} failed`).trim());
  };
  // A worktree made for another clone can't check out this repo's commits, so it's made again (update.rs does the same).
  const commonOf = (dir) => git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir')?.toLowerCase().replace(/\\/g, '/');
  if (existsSync(join(src, '.git')) && commonOf(src) && commonOf(src) === commonOf(repo)) {
    run('-C', src, 'checkout', '--detach', '--force', commit);
    // Leftovers from the last build go, but the npm packages and Cargo's build cache stay.
    run('-C', src, 'clean', '-fdxq', '-e', 'node_modules', '-e', 'target');
  } else {
    rmSync(src, { recursive: true, force: true });
    spawnSync('git', ['-C', repo, 'worktree', 'prune'], { windowsHide: true });
    run('-C', repo, 'worktree', 'add', '--detach', '--force', src, commit);
  }
  // Written before the script starts, as the app does, so a Sketch checking now doesn't start a build too.
  writeFileSync(lockPath, JSON.stringify({ commit }));
  const out = openSync(join(buildDir, 'build.log'), 'w');
  return new Promise((done) => {
    const child = spawn(process.execPath, ['scripts/update-build.mjs', commit, join(data, 'updates'), buildDir, install], {
      cwd: join(src, path),
      stdio: ['ignore', out, out],
      windowsHide: true,
    });
    child.on('exit', (code) => done(code === 0));
    child.on('error', () => done(false));
    // An open Sketch shows its building spinner now; update-build.mjs tells it again when it's done.
    if (pingSketch(data)) log('Told the running Sketch a build started.');
  });
}

async function main() {
  if (!existsSync(join(install, 'current.json')) || !existsSync(join(install, 'sketch.exe'))) {
    log(`Sketch isn't installed in ${install} (the launcher layout from F6), so there's nothing to update.`);
    return;
  }

  if (after) {
    // The hook runs before the push; the remote-tracking ref moves once the push has landed.
    const end = Date.now() + Number(opt('wait') ?? 300) * 1000;
    while (git(repo, 'merge-base', '--is-ancestor', after, ref) === null) {
      if (Date.now() > end) {
        log(`${ref} never reached ${after.slice(0, 7)} (the push failed or went elsewhere), so nothing was built.`);
        return;
      }
      await sleep(2000);
    }
  }

  for (;;) {
    const target = git(repo, 'rev-list', '-1', ref, '--', pathspec);
    if (!target) {
      log(`No commit on ${ref} changes ${pathspec}.`);
      return;
    }
    const current = readJson(join(install, 'current.json'));
    if (current?.commit === target) {
      log(`The installed Sketch is already ${target.slice(0, 7)}.`);
      return;
    }
    if (lockAlive()) {
      const building = readJson(lockPath)?.commit;
      if (building === target) {
        log(`A build of ${target.slice(0, 7)} is already running (started by Sketch), so this leaves it to that one.`);
        return;
      }
      log(`Waiting for the build of ${building?.slice(0, 7) ?? 'another commit'} to finish first.`);
      while (lockAlive()) await sleep(5000);
      continue;
    }
    // From the hook, a commit that failed already waits for the next push, as in the app. By hand it's tried again.
    if (after && readJson(join(buildDir, 'last-error.json'))?.commit === target) {
      log(`The last build of ${target.slice(0, 7)} failed, so it waits for a newer push (npm run dev:update tries again). See build.log.`);
      return;
    }
    log(`Building ${target.slice(0, 7)} into ${install}.`);
    const started = Date.now();
    let ok;
    try {
      ok = await build(target);
    } catch (e) {
      rmSync(lockPath, { force: true });
      writeFileSync(join(buildDir, 'last-error.json'), JSON.stringify({ commit: target, error: e.message, at: new Date().toISOString() }));
      log(`Couldn't start the build: ${e.message}`);
      return;
    }
    if (!ok) {
      log(`The build of ${target.slice(0, 7)} failed. See build.log.`);
      return;
    }
    log(`Staged ${target.slice(0, 7)} in ${Math.round((Date.now() - started) / 1000)} s; the next start of Sketch opens it.`);
    // Loops once more, in case a newer push landed during the build.
  }
}

await main().catch((e) => log(`Failed: ${e.stack ?? e.message}`));
