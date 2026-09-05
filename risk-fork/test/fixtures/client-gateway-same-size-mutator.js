import { closeSync, openSync, writeSync } from 'node:fs';

const target = process.argv[2];
const size = Number.parseInt(process.argv[3], 10);
if (typeof target !== 'string' || !Number.isSafeInteger(size) || size < 1) process.exit(64);

const descriptor = openSync(target, 'r+');
const versions = [Buffer.alloc(size, 0x61), Buffer.alloc(size, 0x62)];
const chunkBytes = 64 * 1024;
let version = 1;
let offset = 0;
let stopping = false;

function stop() {
  if (stopping) return;
  stopping = true;
  closeSync(descriptor);
  process.exit(0);
}

function mutate() {
  if (stopping) return;
  const length = Math.min(chunkBytes, size - offset);
  writeSync(descriptor, versions[version], offset, length, offset);
  offset += length;
  if (offset === size) {
    offset = 0;
    version = version === 0 ? 1 : 0;
  }
  setImmediate(mutate);
}

process.once('SIGINT', stop);
process.once('SIGTERM', stop);
process.stdout.write('ready\n');
setImmediate(mutate);
