// Fails when the installer is over SKETCH_SIZE_BUDGET_MB (default 15).
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const dir = join('src-tauri', 'target', 'release', 'bundle', 'nsis');
const budgetMb = Number(process.env.SKETCH_SIZE_BUDGET_MB ?? 15);

let files;
try {
  files = readdirSync(dir).filter((f) => f.endsWith('.exe'));
} catch {
  files = [];
}
if (!files.length) {
  console.error(`No installer found in ${dir}. Build it first with: npm run tauri build`);
  process.exit(1);
}
let failed = false;
for (const f of files) {
  const mb = statSync(join(dir, f)).size / 1024 / 1024;
  console.log(`${f}: ${mb.toFixed(1)} MB (budget ${budgetMb} MB)`);
  if (mb > budgetMb) failed = true;
}
if (failed) {
  console.error('The installer is over budget.');
  process.exit(1);
}
