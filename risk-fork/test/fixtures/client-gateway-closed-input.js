'use strict';

const { closeSync, writeFileSync } = require('node:fs');
const path = require('node:path');

closeSync(0);
writeFileSync(path.join(__dirname, 'gateway-input-closed.txt'), 'closed');
setTimeout(() => {}, 5_000);
