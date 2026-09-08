'use strict';

process.exit = () => {};
process.kill = () => false;
process.on('exit', () => {
  while (true) {}
});
setInterval(() => {}, 1000);
throw new Error('synthetic compile failure');
