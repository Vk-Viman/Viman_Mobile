// open-when-ready.mjs - used by Start-Viman-Shop.bat in two ways.
//
// 1. "Is the shop already running?" (--check, launcher step 2): one quick health request, exit code 0 = yes, 1 = no.
//    This stops a second copy from being started when the owner double-clicks the launcher twice.
// 2. "Open the browser when ready" (no argument, launcher step 5, started in the background): the server needs a few
//    seconds to start (database check, backup, migrations). Opening the browser immediately would show an error page,
//    so this script keeps asking the server's health address until it answers "ok" and only then opens the browser.
//    It gives up after 60 seconds and tells the owner to open the address by hand.
//
// Why the /health endpoint: it answers only when the server is fully started, and it is the same address the
// automated tests use (server/src/tests/health.test.ts), so its contract is protected.
//
// Default: wait until the server is healthy, then open the browser.
// --check: single health request; exit 0 if healthy, 1 otherwise.
import { spawn } from 'node:child_process';

// 127.0.0.1 (not "localhost") for the check: it avoids name-resolution surprises. The port can be changed with the
// VIMAN_PORT setting, otherwise 4300 (the same default as the server and the launcher).
const host = '127.0.0.1';
const port = process.env.VIMAN_PORT || '4300';
const healthUrl = `http://${host}:${port}/api/v1/health`;
// The address the owner sees in the browser.
const appUrl = `http://localhost:${port}`;

// True only when the server answers 200 with { status: 'ok' }. Any failure (not started yet, wrong program on the
// port, slow answer) simply means "not healthy" - never an error. The 1.5 s timeout keeps each attempt short.
async function isHealthy() {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const body = await res.json();
    return body?.status === 'ok';
  } catch {
    return false;
  }
}

function openBrowser() {
  // rundll32 avoids cmd's quoting rules for the `start "" <url>` title argument.
  // Detached + unref + ignored output: the browser must keep running after this script ends, and no extra console
  // window should flash up.
  const child = spawn('rundll32', ['url.dll,FileProtocolHandler', appUrl], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
}

// Mode 1: single check; the exit code is the answer.
if (process.argv.includes('--check')) {
  process.exit((await isHealthy()) ? 0 : 1);
}

// Mode 2: poll twice a second for up to 60 seconds, open the browser at the first healthy answer.
const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (await isHealthy()) {
    openBrowser();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
// Timed out: the server may have failed to start (its own window shows why).
console.error(`The shop system did not become ready within 60 seconds. Try opening ${appUrl} manually.`);
process.exit(1);
