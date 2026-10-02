import { openSync, readSync, fstatSync, closeSync } from 'node:fs';
import { buildOpenShellPlan, openShellReadiness } from './scaffold.mjs';

// Offline only. No installer, SDK import, subprocess, network, or apply command.
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--readiness') {
    console.log(JSON.stringify(openShellReadiness(), null, 2));
  } else {
    if (args.length !== 1 || args[0].startsWith('-')) throw new Error('usage: node preview.mjs REQUEST.json | --readiness');
    const fd = openSync(args[0], 'r');
    let text;
    try {
      if (!fstatSync(fd).isFile()) throw new Error('request_must_be_regular_file');
      const bytes = Buffer.alloc(65537);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (!count) break;
        size += count;
      }
      if (size > 65536) throw new Error('request_too_large');
      text = bytes.subarray(0, size).toString('utf8');
    } finally { closeSync(fd); }
    let request;
    try { request = JSON.parse(text); } catch { throw new Error('invalid_request_json'); }
    console.log(JSON.stringify(buildOpenShellPlan(request), null, 2));
  }
} catch (error) {
  // Do not echo request contents or filesystem paths from native errors.
  const message = error.code && !error.code.startsWith('E') ? error.code
    : ['invalid_request_json', 'request_too_large', 'request_must_be_regular_file'].includes(error.message) ? error.message
      : 'preview_failed: use one request JSON path or --readiness';
  console.error(message);
  process.exitCode = 2;
}
