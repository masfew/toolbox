// Times how long the built app takes from launch to its first drawn frame.
// Usage: node scripts/startup-check.mjs [path-to-exe]
// Fails when the median of 5 runs is over SKETCH_STARTUP_BUDGET_MS (default 1000).
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exe = process.argv[2] ?? join('src-tauri', 'target', 'release', 'sketch.exe');
const budget = Number(process.env.SKETCH_STARTUP_BUDGET_MS ?? 1000);
const runs = 5;
const timeoutMs = 15000;
// Its own data folder, so the runs never reach a Sketch that's already open or reopen its autosaves.
const dataDir = mkdtempSync(join(tmpdir(), 'sketch-startup-'));

if (!existsSync(exe)) {
  console.error(`App not found at ${exe}. Build it first with: npm run tauri build`);
  process.exit(1);
}

function once(i) {
  const probe = join(tmpdir(), `sketch-startup-probe-${process.pid}-${i}`);
  rmSync(probe, { force: true });
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(exe, [], { env: { ...process.env, SKETCH_STARTUP_PROBE: probe, SKETCH_DATA_DIR: dataDir }, stdio: 'ignore' });
    const timer = setInterval(() => {
      if (existsSync(probe)) {
        clearInterval(timer);
        const ms = performance.now() - start;
        rmSync(probe, { force: true });
        resolve(ms);
      } else if (performance.now() - start > timeoutMs) {
        clearInterval(timer);
        child.kill();
        reject(new Error(`The app didn't report ready within ${timeoutMs} ms`));
      }
    }, 2);
    child.on('error', (e) => {
      clearInterval(timer);
      reject(e);
    });
  });
}

const times = [];
for (let i = 0; i < runs; i++) {
  times.push(await once(i));
  await new Promise((r) => setTimeout(r, 500));
}
const sorted = [...times].sort((a, b) => a - b);
const median = sorted[Math.floor(runs / 2)];
console.log(`Start-up times: ${times.map((t) => `${t.toFixed(0)} ms`).join(', ')}`);
console.log(`First run ${times[0].toFixed(0)} ms, median ${median.toFixed(0)} ms, budget ${budget} ms`);
if (median > budget) {
  console.error('Start-up is over budget.');
  process.exit(1);
}
