#!/usr/bin/env node
/** Offline CLI. One bounded, explicitly supplied JSON file; no stdin, URL, or live mode. */
import { open } from 'node:fs/promises';
import { planIncomeCycle } from './planner.mjs';

const MAX_BYTES = 512 * 1024;
try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-') || /^[a-z][a-z0-9+.-]*:\/\//i.test(args[0])) {
    throw new Error('Usage: node agent-os/income/preview.mjs <local-snapshot.json>; no live mode');
  }
  const file = await open(args[0], 'r');
  let bytes;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('snapshot_must_be_regular_file_under_512KiB');
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(buffer, length, buffer.length - length, null);
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    if (length > MAX_BYTES) throw new Error('snapshot_too_large');
    bytes = buffer.subarray(0, length);
  } finally { await file.close(); }
  const report = planIncomeCycle(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch {
  // Do not echo an untrusted payload or filesystem path into logs.
  process.stderr.write('Income preview rejected. Check the local JSON contract and offline-only usage.\n');
  process.exitCode = 1;
}
