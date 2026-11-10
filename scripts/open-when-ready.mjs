// Default: wait until the server is healthy, then open the browser.
// --check: single health request; exit 0 if healthy, 1 otherwise.
import { spawn } from 'node:child_process';

const host = '127.0.0.1';
const port = process.env.VIMAN_PORT || '4300';
const healthUrl = `http://${host}:${port}/api/v1/health`;
const appUrl = `http://localhost:${port}`;

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
  const child = spawn('rundll32', ['url.dll,FileProtocolHandler', appUrl], {
    stdio: 'ignore',
    detached: true,
    windowsHide: true,
  });
  child.unref();
}

if (process.argv.includes('--check')) {
  process.exit((await isHealthy()) ? 0 : 1);
}

const deadline = Date.now() + 60_000;
while (Date.now() < deadline) {
  if (await isHealthy()) {
    openBrowser();
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error(`The shop system did not become ready within 60 seconds. Try opening ${appUrl} manually.`);
process.exit(1);
