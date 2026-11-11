// check-node.mjs - used by Start-Viman-Shop.bat (step 1) before anything else runs.
//
// The shop system uses built-in Node features (for example the node:sqlite database and running TypeScript
// directly) that only exist in recent Node versions, so we stop early with a clear message instead of letting
// the owner see a confusing crash later.
//
// Result is the exit code, which the launcher tests with "if errorlevel 1":
//   0 = Node.js 24 or newer is installed, 1 = too old.
//
// Exit 0 if Node.js major version >= 24, otherwise print a message and exit 1.

// "24.1.0" -> 24: only the major version matters.
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major >= 24) {
  process.exit(0);
}
// Printed on the error stream so it is visible in the launcher window.
console.error(`Node.js 24 or newer is required (found ${process.versions.node}).`);
process.exit(1);
