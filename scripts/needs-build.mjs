// needs-build.mjs - used by Start-Viman-Shop.bat (step 4) to decide whether the web screens must be rebuilt.
//
// Building the web app takes a while, so the launcher only does it when needed: when there is no build yet, or when
// any source file is NEWER than the last build. "Newer" is judged by file modification time (timestamp) because it
// is instant to check and needs no extra tools; a rebuild that is not strictly necessary is harmless, a missing
// rebuild would show the owner an outdated screen.
//
// Result is the exit code (the launcher tests it with "if errorlevel 1"):
//   0 = web build is up to date, 1 = build needed (the reason is printed).
//
// Exit 0 = web build is up to date, 1 = build needed (reason printed).
import { statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// The project root is the folder above this script, wherever the project is installed.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The built entry page; its timestamp is "when the last build finished".
const distIndex = join(root, 'web', 'dist', 'index.html');

// Modification time in milliseconds, or null when the file does not exist (missing is not an error here).
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
  // A plain file is its own answer; a folder is searched recursively and the newest file inside wins.
  if (!st.isDirectory()) return { path: p, time: t };
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const found = newest(join(p, entry.name));
    if (found && (!best || found.time > best.time)) best = found;
  }
  return best;
}

// Step 1: no build at all -> a build is certainly needed.
const distTime = mtime(distIndex);
if (distTime === null) {
  console.log('Build needed: web/dist/index.html is missing.');
  process.exit(1);
}

// Step 2: the places whose changes affect the screens (source code, the HTML shell, the build settings).
const sources = [join(root, 'web', 'src'), join(root, 'web', 'index.html'), join(root, 'web', 'vite.config.ts')];
for (const s of sources) {
  const n = newest(s);
  // Any file edited after the last build means the build is stale; the first one found is enough to decide.
  if (n && n.time > distTime) {
    console.log(`Build needed: ${n.path} is newer than the last build.`);
    process.exit(1);
  }
}
// Step 3: nothing newer than the build -> reuse it, so starting the shop stays fast.
console.log('Web build is up to date.');
process.exit(0);
