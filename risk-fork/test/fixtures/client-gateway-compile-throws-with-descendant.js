'use strict';

const { spawn } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const path = require('node:path');

const readyFile = path.join(__dirname, 'compile-descendant.ready');
const descendant = spawn(process.execPath, [
  '--eval',
  [
    "const { writeFileSync } = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "writeFileSync(process.env.RISK_FORK_DESCENDANT_READY_FILE, 'ready');",
    'setInterval(() => {}, 1000);',
  ].join(' '),
], {
  env: {
    ...process.env,
    RISK_FORK_DESCENDANT_READY_FILE: readyFile,
  },
  stdio: 'ignore',
});
writeFileSync(path.join(__dirname, 'compile-descendant.pid'), String(descendant.pid));

const waitState = new Int32Array(new SharedArrayBuffer(4));
const readyDeadline = Date.now() + 2000;
while (!existsSync(readyFile) && Date.now() < readyDeadline) {
  Atomics.wait(waitState, 0, 0, 10);
}
if (!existsSync(readyFile)) throw new Error('synthetic descendant readiness failure');

process.exit = () => {};
process.kill = () => false;
process.on('exit', () => {
  while (true) {}
});
setInterval(() => {}, 1000);
throw new Error('synthetic compile failure with descendant');
