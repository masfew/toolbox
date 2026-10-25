// Tells a running Sketch to check for updates now, so its building spinner or ready icon shows at
// once instead of at its next timed check. It writes `--update-check` to the pipe a second launch
// of Sketch uses (src-tauri/src/instance.rs), whose name comes from the data folder. With no Sketch
// running there's no pipe, and nothing happens: Sketch is never started.
import { closeSync, openSync, writeSync, constants } from 'node:fs';

/** instance.rs's `key_hash`: FNV-1a of the lower-cased path. */
export function keyHash(key) {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(key.toLowerCase(), 'utf8')) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, '0');
}

/** True when a running Sketch took the message. `dataDir` must be the path Sketch uses, as written. */
export function pingSketch(dataDir) {
  if (process.platform !== 'win32') return false;
  const pipe = `\\\\.\\pipe\\sketch-${keyHash(dataDir)}`;
  const body = Buffer.from(JSON.stringify({ args: ['sketch', '--update-check'], cwd: '' }));
  for (let i = 0; i < 10; i++) {
    try {
      // Write-only and no create flags: the pipe only reads, and only an existing one will do.
      const fd = openSync(pipe, constants.O_WRONLY);
      try {
        writeSync(fd, body);
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (e) {
      // Sketch is reading another message: try again in a moment.
      if (e.code !== 'EBUSY') return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  return false;
}
