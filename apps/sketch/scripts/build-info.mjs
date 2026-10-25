// The commit a build comes from, stamped into the app (as __SKETCH_BUILD__) so it knows which
// commit it is for in-app updates. `repo` is the main checkout of the repo Sketch sits in, even in
// the update worktree, and `path` is Sketch's folder inside it (`apps/sketch`, or empty when Sketch
// is the repo's root), so updates work wherever the folder is. A release build (SKETCH_RELEASE=1,
// set by build.ps1) stamps no repo: an installer downloaded from a release has no clone to update from.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sketchDir = fileURLToPath(new URL('..', import.meta.url));

const git = (...args) => {
  try {
    return execFileSync('git', ['-C', sketchDir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

/**
 * The version people see: package.json's major and minor, then the number of commits that changed
 * Sketch's folder, so every update counts up on its own with nothing to bump by hand.
 */
function version() {
  const [major, minor] = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version.split('.');
  return `${major}.${minor}.${git('rev-list', '--count', 'HEAD', '--', '.') || 0}`;
}

export function buildInfo() {
  const common = process.env.SKETCH_RELEASE === '1' ? '' : git('rev-parse', '--path-format=absolute', '--git-common-dir');
  return {
    version: version(),
    commit: git('rev-parse', 'HEAD'),
    subject: git('log', '-1', '--format=%s'),
    builtAt: new Date().toISOString(),
    repo: common ? dirname(common) : '',
    path: git('rev-parse', '--show-prefix').replace(/\/$/, ''),
  };
}

// `node scripts/build-info.mjs --nsis` (part of `npm run build`): the installer's hooks
// (src-tauri/windows/hooks.nsh) name the first version folder after the commit, so they read it
// from src-tauri/windows/version.nsh, written here before each build.
if (process.argv[1]?.endsWith('build-info.mjs') && process.argv.includes('--nsis')) {
  const { writeFileSync } = await import('node:fs');
  const { commit, builtAt } = buildInfo();
  const short = commit ? commit.slice(0, 7) : 'local';
  writeFileSync(
    new URL('../src-tauri/windows/version.nsh', import.meta.url),
    `; Written by scripts/build-info.mjs for each build; not in git.\n!define SKETCH_COMMIT "${commit}"\n!define SKETCH_VERSION_FOLDER "app-${short}"\n!define SKETCH_BUILT_AT "${builtAt}"\n`,
  );
}
