'use strict';

process.on('SIGTERM', () => {});
process.stdout.write('not-json\n');
setInterval(() => {}, 1_000);
