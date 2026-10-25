// Checks what uninstalling does with Sketch's data folder, on scratch folders: the uninstall steps in
// src-tauri/windows/hooks.nsh (SKETCH_KEEP_DATA_CHOICE and NSIS_HOOK_POSTUNINSTALL) are compiled with
// Tauri's NSIS into a stand-in uninstaller, pointed at a scratch data folder, and run the ways Sketch's
// real uninstaller runs:
//  1. A normal uninstall (Settings > Apps, or install.py --remove, which passes /S) removes the whole
//     data folder, and prunes the update build's git worktree from the clone it belongs to.
//  2. Ticking the keep box, /KEEPDATA, an update (/UPDATE) and an uninstaller run in place (as Tauri's
//     installer does before installing again) all keep it.
//  3. A file still in use for a moment (WebView2 letting go of its profile) is waited for; one held for
//     good is left, and the uninstall still finishes within seconds.
// The stand-in uninstaller only runs those steps: nothing touches the installed Sketch, its data
// folder, its helpers or the registry. Usage: node scripts/uninstall-check.mjs (Windows only; needs
// Tauri's NSIS, which npm run tauri build downloads, and src-tauri/windows/version.nsh, which
// npm run build writes).
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const sketchDir = resolve('.');
const makensis = join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe');
if (!existsSync(makensis) || !existsSync(join(sketchDir, 'src-tauri', 'windows', 'version.nsh'))) {
  console.error(`Build Sketch first with: npm run tauri build (it downloads Tauri's NSIS to ${makensis})`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'sketch-uninstall-'));
const install = join(work, 'install');
const data = join(work, 'data');
const repo = join(work, 'repo');
const done = join(work, 'done.txt');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=Uninstall check', '-c', 'user.email=check@example.com', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const worktrees = () => git('worktree', 'list', '--porcelain').split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length;

const results = [];
function expect(cond, message) {
  if (!cond) throw new Error(message);
}
async function check(name, fn) {
  try {
    await fn();
    results.push(true);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}

/** A data folder as Sketch leaves it, with an update build's worktree of the scratch clone. */
function makeData() {
  rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  git('worktree', 'prune');
  for (const [file, text] of [
    ['capture.json', '{"keys":"Ctrl+Alt+Shift+F11"}'],
    ['window.json', '{}'],
    ['recovery/tab-1.json', '{}'],
    ['captures/1.png', 'png'],
    ['cutout/onnxruntime.dll', 'dll'],
    ['cutout/u2net.onnx', 'model'],
    ['EBWebView/Default/Local Storage/leveldb/000003.log', 'settings'],
  ]) {
    mkdirSync(join(data, file, '..'), { recursive: true });
    writeFileSync(join(data, file), text);
  }
  git('worktree', 'add', '-q', '--detach', join(data, 'build', 'sketch-update-build'));
  expect(worktrees() === 2, 'The scratch worktree was not made');
}

/** Runs the stand-in uninstaller and waits for it (a normal run copies itself to the temp folder and returns at once). */
async function uninstall(args, env = {}) {
  rmSync(done, { force: true });
  const started = Date.now();
  spawnSync(join(install, 'uninstall.exe'), args, { env: { ...process.env, SKETCH_TEST_DATA: data, SKETCH_TEST_DONE: done, ...env } });
  while (!existsSync(done)) {
    expect(Date.now() - started < 30_000, `The uninstaller didn't finish within 30 s (${args.join(' ')})`);
    await sleep(100);
  }
  await sleep(100);
  return { keep: readFileSync(done, 'utf8').trim(), seconds: (Date.now() - started) / 1000 };
}

/** Holds a data file open the way a running program does (no sharing for delete), for `ms`. */
async function hold(file, ms) {
  const held = join(work, 'held.txt');
  rmSync(held, { force: true });
  const child = spawn('powershell', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${join(data, file)}', 'Open', 'Read', 'Read'); Set-Content '${held}' 1; Start-Sleep -Milliseconds ${ms}; $f.Close()`], { stdio: 'ignore' });
  const end = Date.now() + 15_000;
  while (!existsSync(held)) {
    expect(Date.now() < end, 'PowerShell never opened the file');
    await sleep(100);
  }
  return child;
}

try {
  mkdirSync(install);
  mkdirSync(repo);
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');

  const nsh = join(sketchDir, 'src-tauri', 'windows', 'hooks.nsh');
  const script = join(work, 'uninstall-test.nsi');
  writeFileSync(
    script,
    `Unicode true
!include LogicLib.nsh
!include FileFunc.nsh
!define MAINBINARYNAME "sketch"
!define SKETCH_TEST_DATA_DIR "$1"
Var UpdateMode
Var DeleteAppDataCheckboxState
!include "${nsh}"
OutFile "${join(work, 'setup-test.exe')}"
RequestExecutionLevel user
SilentInstall silent
Section
  ReadEnvStr $INSTDIR SKETCH_TEST_INSTDIR
  WriteUninstaller "$INSTDIR\\uninstall.exe"
SectionEnd
; As Tauri's un.onInit sets it; the box's state comes from SKETCH_TEST_BOX.
Function un.onInit
  ClearErrors
  \${GetOptions} $CMDLINE "/UPDATE" $0
  \${IfNot} \${Errors}
    StrCpy $UpdateMode 1
  \${EndIf}
  ReadEnvStr $DeleteAppDataCheckboxState SKETCH_TEST_BOX
FunctionEnd
; The data folder steps of Tauri's uninstall section with Sketch's hooks, nothing else.
Section Uninstall
  ReadEnvStr $1 SKETCH_TEST_DATA
  !insertmacro SKETCH_KEEP_DATA_CHOICE
  StrCpy $DeleteAppDataCheckboxState 0
  !insertmacro NSIS_HOOK_POSTUNINSTALL
  ReadEnvStr $0 SKETCH_TEST_DONE
  FileOpen $2 $0 w
  FileWrite $2 $SketchKeepData
  FileClose $2
SectionEnd
`,
  );
  const compiled = spawnSync(makensis, ['/V2', script], { encoding: 'utf8' });
  if (compiled.status !== 0) throw new Error(`makensis failed:\n${compiled.stdout}${compiled.stderr}`);
  execFileSync(join(work, 'setup-test.exe'), [], { env: { ...process.env, SKETCH_TEST_INSTDIR: install } });
  if (!existsSync(join(install, 'uninstall.exe'))) throw new Error('The stand-in uninstaller was not written');

  await check('A normal uninstall removes the whole data folder and prunes the update build worktree', async () => {
    makeData();
    const r = await uninstall(['/S']);
    expect(r.keep === '0', `It chose to keep the data (${r.keep})`);
    expect(!existsSync(data), 'The data folder is still there');
    expect(worktrees() === 1, "The clone still lists the update build's worktree");
  });

  for (const [name, args, env] of [
    ['Ticking the keep box', ['/S'], { SKETCH_TEST_BOX: '1' }],
    ['/KEEPDATA', ['/S', '/KEEPDATA'], {}],
    ['An update (/UPDATE)', ['/S', '/UPDATE'], {}],
    ['An uninstaller run in place (as an installer runs it before installing again)', ['/S', `_?=${install}`], {}],
  ])
    await check(`${name} keeps the data folder`, async () => {
      makeData();
      const r = await uninstall(args, env);
      expect(r.keep === '1', `It chose to remove the data (${r.keep})`);
      for (const f of ['capture.json', 'recovery/tab-1.json', 'cutout/u2net.onnx', 'EBWebView/Default/Local Storage/leveldb/000003.log'])
        expect(existsSync(join(data, f)), `${f} is gone`);
      expect(worktrees() === 2, "The clone lost the update build's worktree");
    });

  await check('A file in use for a moment is waited for, and the data folder still goes', async () => {
    makeData();
    const child = await hold('EBWebView/Default/Local Storage/leveldb/000003.log', 1500);
    await uninstall(['/S']);
    child.kill();
    expect(!existsSync(data), 'The data folder is still there');
  });

  await check('A file held for good is left, and the uninstall still finishes within 10 seconds', async () => {
    makeData();
    const child = await hold('cutout/onnxruntime.dll', 20_000);
    const r = await uninstall(['/S']);
    child.kill();
    expect(r.seconds < 10, `It took ${r.seconds} s`);
    expect(existsSync(join(data, 'cutout', 'onnxruntime.dll')), 'The held file is gone, so the check held nothing');
    expect(!existsSync(join(data, 'recovery')) && !existsSync(join(data, 'build')), 'Files that were not in use were left');
    expect(worktrees() === 1, "The clone still lists the update build's worktree");
  });
} catch (e) {
  results.push(false);
  console.log(`FAIL  ${e.message}`);
} finally {
  await sleep(500);
  try {
    rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch {}
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} uninstall checks passed.`);
if (failed || !results.length) process.exit(1);
