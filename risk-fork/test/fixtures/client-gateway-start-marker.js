'use strict';

const { writeFileSync } = require('node:fs');
const path = require('node:path');

writeFileSync(path.join(__dirname, 'gateway-started.txt'), 'started');
writeFileSync(path.join(__dirname, 'gateway.pid'), String(process.pid));
process.on('SIGTERM', () => {});
process.stdin.resume();
