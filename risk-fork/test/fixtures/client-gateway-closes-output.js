'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
let outputClosed = false;
function closeOutput() {
  if (outputClosed) return;
  outputClosed = true;
  process.stdout.end();
}
input.on('line', closeOutput);
setTimeout(closeOutput, 100);
setInterval(() => {}, 1000);
