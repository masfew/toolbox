// The files a release install updates itself from (F16.4), written by build.ps1 after the release
// build: sketch-<version>-app.zip (the version folder: sketch.exe, sketch-capture.exe, version.json,
// plus the launcher) and, when SKETCH_UPDATE_KEY holds the Ed25519 signing key (PEM), latest.json,
// which the release workflow also puts on the fixed sketch-latest release. latest.json is
// {"signed": "<JSON>", "signature": "<hex>"}; the inner JSON names the version, its build number and
// the zip's address, size and SHA-512 (src-tauri/src/download.rs checks all of it).
// Usage: node scripts/release-files.mjs <out-folder>
// SKETCH_DOWNLOAD_BASE overrides where the zip is said to be (checks serve it locally); otherwise
// it's the sketch-v<version> release of GITHUB_REPOSITORY or the clone's GitHub origin.
import { createHash, createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zipSync } from 'fflate';
import { buildInfo, releasesUrl, updateKey } from './build-info.mjs';

const out = process.argv[2];
if (!out) {
  console.error('Usage: node scripts/release-files.mjs <out-folder>');
  process.exit(2);
}

const release = join(process.env.CARGO_TARGET_DIR || join('src-tauri', 'target'), 'release');
const { version: tauriVersion } = JSON.parse(readFileSync(join('src-tauri', 'tauri.conf.json'), 'utf8'));
const info = buildInfo();
for (const exe of ['sketch.exe', 'sketch-capture.exe', 'sketch-launcher.exe']) {
  if (!existsSync(join(release, exe))) {
    console.error(`No ${join(release, exe)}: build first.`);
    process.exit(1);
  }
}

// builtAt first: the launcher reads it with a plain text search.
const stamp = { builtAt: info.builtAt, commit: info.commit, subject: info.subject, build: info.build, version: info.version };
const zip = zipSync(
  {
    'sketch.exe': readFileSync(join(release, 'sketch.exe')),
    'sketch-capture.exe': readFileSync(join(release, 'sketch-capture.exe')),
    'sketch-launcher.exe': readFileSync(join(release, 'sketch-launcher.exe')),
    'version.json': new TextEncoder().encode(JSON.stringify(stamp, null, 2)),
  },
  { level: 9 },
);
mkdirSync(out, { recursive: true });
const file = `sketch-${tauriVersion}-app.zip`;
writeFileSync(join(out, file), zip);
console.log(`Wrote ${join(out, file)} (${(zip.length / 1e6).toFixed(1)} MB, build ${info.build})`);

const pem = process.env.SKETCH_UPDATE_KEY;
if (!pem) {
  console.log("SKETCH_UPDATE_KEY isn't set, so this release has no latest.json and release installs won't update to it.");
  process.exit(0);
}
if (!info.commit) {
  console.error('No commit: latest.json needs a git checkout.');
  process.exit(1);
}
const base = process.env.SKETCH_DOWNLOAD_BASE || (releasesUrl() && `${releasesUrl()}/download/sketch-v${tauriVersion}/`);
if (!base) {
  console.error("Couldn't tell which GitHub repo this is (no GITHUB_REPOSITORY and no GitHub origin).");
  process.exit(1);
}
const signed = JSON.stringify({
  version: tauriVersion,
  build: info.build,
  commit: info.commit,
  subject: info.subject,
  url: `${base.replace(/\/?$/, '/')}${file}`,
  size: zip.length,
  sha512: createHash('sha512').update(zip).digest('hex'),
});
const signature = sign(null, Buffer.from(signed), createPrivateKey(pem)).toString('hex');
writeFileSync(join(out, 'latest.json'), `${JSON.stringify({ signed, signature }, null, 2)}\n`);
console.log(`Wrote ${join(out, 'latest.json')}, signed with the key ${updateKey().slice(0, 16)}…`);
