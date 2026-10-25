// Builds one commit for in-app updates. Sketch starts it in the background, in its own git worktree
// of the commit (see src-tauri/src/update.rs), never in the shared project folder.
// Usage: node scripts/update-build.mjs <commit> <updates-folder> <build-folder> [<install-folder>]
//
// Runs `npm ci` only when package-lock.json changed since the last build, then the release build
// (Cargo's cache stays in the worktree between builds). A failure is written to last-error.json, so
// the same commit isn't tried again until something newer is pushed.
//
// With an install folder (Silent Updates, F6), the build is staged there as a new version folder
// beside the running one: copied to app-<short commit>.part, checked, renamed to app-<short commit>,
// and only then named in current.json, so a start mid-copy still opens the version before. The
// running Sketch is never touched; the next start opens the new build. The launcher is swapped in
// when it changed. Without one (a Sketch from before F6, which installs updates with the installer),
// it builds the installer and writes latest.json beside it, as before; that installer is what moves
// such a Sketch to the launcher layout.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pingSketch } from './ping-sketch.mjs';

const [commit, updates, buildDir, install] = process.argv.slice(2);
if (!commit || !updates || !buildDir) {
  console.error('Usage: node scripts/update-build.mjs <commit> <updates-folder> <build-folder> [<install-folder>]');
  process.exit(2);
}

const lock = join(buildDir, 'build.lock');
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
const write = (path, text) => {
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('hex');
const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

// The app treats a lock that hasn't been touched for 90 s as a dead build.
writeFileSync(lock, JSON.stringify({ commit, pid: process.pid }));
const heartbeat = setInterval(() => {
  const now = new Date();
  try {
    utimesSync(lock, now, now);
  } catch {}
}, 10_000);

const env = { ...process.env };
// Rust from rustup may not be on the PATH Explorer gave the app.
const cargoBin = join(homedir(), '.cargo', 'bin');
if (existsSync(cargoBin)) env.PATH = `${cargoBin};${env.PATH ?? env.Path ?? ''}`;
delete env.Path;
// The check's or the user's data folder override must not leak into the build.
delete env.SKETCH_DATA_DIR;

function run(cmd, args) {
  log(`${cmd} ${args.join(' ')}`);
  // npm is a .cmd on Windows, so it goes through the shell. Hidden, so a Sketch started before the
  // build had a windowless console of its own doesn't open a terminal window for each step.
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32', windowsHide: true });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.status ?? r.error?.message})`);
}

/** Moves a folder aside, then deletes it. A folder with a running program inside can't be moved, so it stays whole. */
function removeFolder(root, name) {
  const trash = join(root, `.trash-${name}`);
  try {
    rmSync(trash, { recursive: true, force: true });
    renameSync(join(root, name), trash);
  } catch {
    return false;
  }
  rmSync(trash, { recursive: true, force: true });
  return true;
}

/** Copies the built programs into a new version folder in the install folder and names it in current.json. */
function stage(root, release, subject) {
  const short = commit.slice(0, 7);
  const folder = `app-${short}`;
  const part = join(root, `${folder}.part`);
  mkdirSync(root, { recursive: true });
  rmSync(part, { recursive: true, force: true });
  mkdirSync(part);
  for (const exe of ['sketch.exe', 'sketch-capture.exe']) {
    copyFileSync(join(release, exe), join(part, exe));
    if (sha512(join(part, exe)) !== sha512(join(release, exe))) throw new Error(`The copy of ${exe} doesn't match the build`);
  }
  // builtAt first: the launcher reads it with a plain text search.
  writeFileSync(join(part, 'version.json'), JSON.stringify({ builtAt: new Date().toISOString(), commit, subject }, null, 2));
  if (existsSync(join(root, folder)) && !removeFolder(root, folder)) throw new Error(`${folder} is in use, so it can't be replaced`);
  renameSync(part, join(root, folder));

  // The launcher, when this build's differs. A running exe can be renamed aside; the launcher deletes the .old one.
  const launcher = join(root, 'sketch.exe');
  const built = join(release, 'sketch-launcher.exe');
  if (!existsSync(launcher) || sha512(launcher) !== sha512(built)) {
    copyFileSync(built, `${launcher}.new`);
    rmSync(`${launcher}.old`, { force: true });
    if (existsSync(launcher)) renameSync(launcher, `${launcher}.old`);
    try {
      renameSync(`${launcher}.new`, launcher);
    } catch (e) {
      if (existsSync(`${launcher}.old`)) renameSync(`${launcher}.old`, launcher);
      throw e;
    }
    log('Swapped in the new launcher');
  }

  // Only now does the next start open it: current.json is written whole.
  const before = readJson(join(root, 'current.json'));
  const previous = before?.folder && before.folder !== folder && existsSync(join(root, before.folder)) ? before.folder : '';
  write(join(root, 'current.json'), JSON.stringify({ folder, commit, previous }, null, 2));

  // Versions older than the one before go, unless one is still running (it can't be moved).
  for (const name of readdirSync(root)) {
    if (name.startsWith('app-') && name !== folder && name !== previous) {
      if (name.endsWith('.part')) rmSync(join(root, name), { recursive: true, force: true });
      else removeFolder(root, name);
    }
  }
  log(`Staged ${folder}`);
}

try {
  const started = Date.now();
  const lockHash = createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
  const lockMarker = join(buildDir, 'package-lock.sha256');
  const installed = existsSync(lockMarker) ? readFileSync(lockMarker, 'utf8').trim() : '';
  if (installed !== lockHash || !existsSync('node_modules')) {
    run('npm', ['ci', '--no-audit', '--no-fund']);
    writeFileSync(lockMarker, lockHash);
  }
  const subject = execFileSync('git', ['log', '-1', '--format=%s', commit], { encoding: 'utf8', windowsHide: true }).trim();

  if (install) {
    // No installer: the version folder needs only the programs.
    run('npm', ['run', 'tauri', '--', 'build', '--no-bundle']);
    stage(install, join('src-tauri', 'target', 'release'), subject);
  } else {
    run('npm', ['run', 'tauri', '--', 'build']);
    const bundle = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
    const setup = readdirSync(bundle)
      .filter((f) => f.endsWith('-setup.exe'))
      .map((f) => join(bundle, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
    if (!setup) throw new Error(`No installer in ${bundle}`);
    mkdirSync(updates, { recursive: true });
    const file = `Sketch-${commit.slice(0, 7)}-setup.exe`;
    copyFileSync(setup, join(updates, `${file}.tmp`));
    renameSync(join(updates, `${file}.tmp`), join(updates, file));
    write(join(updates, 'latest.json'), JSON.stringify({ commit, subject, builtAt: new Date().toISOString(), file, sha512: sha512(join(updates, file)) }, null, 2));
    for (const f of readdirSync(updates)) {
      if (f.endsWith('-setup.exe') && f !== file) rmSync(join(updates, f), { force: true });
    }
    log(`Built ${file}`);
  }
  rmSync(join(buildDir, 'last-error.json'), { force: true });
  log(`Done in ${Math.round((Date.now() - started) / 1000)} s`);
} catch (e) {
  log(`Build failed: ${e.message}`);
  write(join(buildDir, 'last-error.json'), JSON.stringify({ commit, error: e.message, at: new Date().toISOString() }));
  process.exitCode = 1;
} finally {
  clearInterval(heartbeat);
  rmSync(lock, { force: true });
  // An open Sketch swaps its building spinner for the ready icon (or drops it after a failure) now.
  // The build folder is the data folder's `build`.
  pingSketch(dirname(buildDir));
}
