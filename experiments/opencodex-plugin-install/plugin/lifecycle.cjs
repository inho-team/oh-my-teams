const fs = require('node:fs');
const marker = process.env.OMT_MARKER;

if (marker) {
  fs.appendFileSync(marker, `${new Date().toISOString()} postinstall\n`);
}
