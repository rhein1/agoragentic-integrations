'use strict';

const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const path = require('node:path');

const descendant = spawn(process.execPath, [
  '--eval',
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
], { stdio: 'ignore' });
writeFileSync(path.join(__dirname, 'descendant.pid'), String(descendant.pid));
process.stdout.write('not-json\n');
setTimeout(() => process.exit(0), 10);
