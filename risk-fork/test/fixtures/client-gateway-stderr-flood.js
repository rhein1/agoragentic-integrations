'use strict';

process.stderr.write(Buffer.alloc(40 * 1024, 0x78));
setTimeout(() => process.stderr.write(Buffer.alloc(40 * 1024, 0x78)), 25);
process.stdin.resume();
