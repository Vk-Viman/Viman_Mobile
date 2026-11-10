// Exit 0 = web build is up to date, 1 = build needed (reason printed).
import { statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = join(root, 'web', 'dist', 'index.html');

function mtime(p) {
  try {
    return statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

/** Returns the newest file { path, time } under a path (file or directory). */
function newest(p) {
  let best = null;
  const t = mtime(p);
  if (t === null) return best;
  let st;
  try {
    st = statSync(p);
  } catch {
    return best;
  }
  if (!st.isDirectory()) return { path: p, time: t };
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const found = newest(join(p, entry.name));
    if (found && (!best || found.time > best.time)) best = found;
  }
  return best;
}

const distTime = mtime(distIndex);
if (distTime === null) {
  console.log('Build needed: web/dist/index.html is missing.');
  process.exit(1);
}

const sources = [join(root, 'web', 'src'), join(root, 'web', 'index.html'), join(root, 'web', 'vite.config.ts')];
for (const s of sources) {
  const n = newest(s);
  if (n && n.time > distTime) {
    console.log(`Build needed: ${n.path} is newer than the last build.`);
    process.exit(1);
  }
}
console.log('Web build is up to date.');
process.exit(0);
