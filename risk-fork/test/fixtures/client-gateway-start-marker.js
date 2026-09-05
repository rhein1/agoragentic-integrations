'use strict';

const { writeFileSync } = require('node:fs');
const path = require('node:path');

writeFileSync(path.join(__dirname, 'gateway-started.txt'), 'started');
process.stdin.resume();
