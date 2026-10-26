// The commit a build comes from, stamped into the app (as __SKETCH_BUILD__) so it knows which
// commit it is for in-app updates. `repo` is the main checkout of the repo Sketch sits in, even in
// the update worktree, and `path` is Sketch's folder inside it (`apps/sketch`, or empty when Sketch
// is the repo's root), so updates work wherever the folder is. A release build (SKETCH_RELEASE=1,
// set by build.ps1) stamps no repo: an installer downloaded from a release has no clone to update from,
// so it stamps the `release` channel instead, the repo's releases page (from GITHUB_REPOSITORY in the
// release workflow, or the clone's GitHub origin) and the public half of SKETCH_UPDATE_KEY, which
// signs each release's latest.json (F16). `build` counts Sketch's commits, for comparing versions.
// The Rust side gets the same stamp through src-tauri/stamp.json (written with --nsis, read by build.rs).
import { execFileSync } from 'node:child_process';
import { createPrivateKey, createPublicKey } from 'node:crypto';
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
function version(build) {
  const [major, minor] = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version.split('.');
  return `${major}.${minor}.${build}`;
}

/** `https://github.com/<owner>/<repo>/releases`: the release workflow's repo, or the clone's GitHub origin. */
export function releasesUrl() {
  const repo = process.env.GITHUB_REPOSITORY || /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(git('remote', 'get-url', 'origin'))?.[1];
  return repo ? `https://github.com/${repo}/releases` : '';
}

/** The public key (hex) for the Ed25519 private key in SKETCH_UPDATE_KEY (PEM), or '' without one. */
export function updateKey() {
  const pem = process.env.SKETCH_UPDATE_KEY;
  if (!pem) return '';
  return Buffer.from(createPublicKey(createPrivateKey(pem)).export({ format: 'jwk' }).x, 'base64url').toString('hex');
}

export function buildInfo() {
  const release = process.env.SKETCH_RELEASE === '1';
  const common = release ? '' : git('rev-parse', '--path-format=absolute', '--git-common-dir');
  const build = Number(git('rev-list', '--count', 'HEAD', '--', '.')) || 0;
  return {
    version: version(build),
    commit: git('rev-parse', 'HEAD'),
    subject: git('log', '-1', '--format=%s'),
    builtAt: new Date().toISOString(),
    repo: common ? dirname(common) : '',
    path: git('rev-parse', '--show-prefix').replace(/\/$/, ''),
    build,
    channel: release ? 'release' : 'source',
    releases: release ? releasesUrl() : '',
    key: release ? updateKey() : '',
  };
}

// `node scripts/build-info.mjs --nsis` (part of `npm run build`): the installer's hooks
// (src-tauri/windows/hooks.nsh) name the first version folder after the commit, so they read it
// from src-tauri/windows/version.nsh, written here before each build. The stamp for the Rust side
// goes to src-tauri/stamp.json at the same time (without builtAt, so it changes only with the commit).
if (process.argv[1]?.endsWith('build-info.mjs') && process.argv.includes('--nsis')) {
  const { writeFileSync } = await import('node:fs');
  const info = buildInfo();
  const { commit, builtAt } = info;
  const { builtAt: _, ...stamp } = info;
  writeFileSync(new URL('../src-tauri/stamp.json', import.meta.url), `${JSON.stringify(stamp, null, 2)}\n`);
  const short = commit ? commit.slice(0, 7) : 'local';
  writeFileSync(
    new URL('../src-tauri/windows/version.nsh', import.meta.url),
    `; Written by scripts/build-info.mjs for each build; not in git.\n!define SKETCH_COMMIT "${commit}"\n!define SKETCH_VERSION_FOLDER "app-${short}"\n!define SKETCH_BUILT_AT "${builtAt}"\n`,
  );
}
