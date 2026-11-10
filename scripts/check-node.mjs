// Exit 0 if Node.js major version >= 24, otherwise print a message and exit 1.
const major = Number.parseInt(process.versions.node.split('.')[0], 10);
if (major >= 24) {
  process.exit(0);
}
console.error(`Node.js 24 or newer is required (found ${process.versions.node}).`);
process.exit(1);
