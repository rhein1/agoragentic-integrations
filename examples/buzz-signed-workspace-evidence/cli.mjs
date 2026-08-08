#!/usr/bin/env node
import { open, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BuzzEvidenceError,
  compileBuzzEvidenceBundle,
} from './buzz-event-evidence.mjs';

export const MAX_INPUT_BYTES = 4 * 1024 * 1024;

function usage() {
  return `Usage:
  node cli.mjs <events.json> [--content-policy hash_only|bounded]
                             [--relay-url <url>]
                             [--community <ref>]
                             [--out <bundle.json>]

Input may be a JSON array of Nostr events or an object containing { events }.
The command performs no relay connection, signature signing, workspace write,
payment, deployment, publication, or trust mutation.
`;
}

export function parseArgs(argv) {
  const args = [...argv];
  const result = {
    input: null,
    out: null,
    content_policy: 'hash_only',
    relay_url: null,
    community_ref: null,
  };
  while (args.length > 0) {
    const value = args.shift();
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--out' || value === '-o') result.out = args.shift() || null;
    else if (value === '--content-policy') result.content_policy = args.shift() || '';
    else if (value === '--relay-url') result.relay_url = args.shift() || null;
    else if (value === '--community') result.community_ref = args.shift() || null;
    else if (String(value).startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else if (!result.input) result.input = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }
  if (!result.input) throw new Error('An events JSON file is required.');
  return result;
}

export async function readBoundedJsonFile(inputPath) {
  const handle = await open(inputPath, 'r');
  try {
    const before = await handle.stat();
    if (!before.isFile()) {
      throw new BuzzEvidenceError('invalid_input', 'Input must be a regular JSON file.');
    }
    if (before.size > MAX_INPUT_BYTES) {
      throw new BuzzEvidenceError(
        'input_too_large',
        `Input JSON exceeds the ${MAX_INPUT_BYTES}-byte CLI limit.`,
      );
    }

    // Allocate at most the configured bound plus one sentinel byte. A file that
    // grows while being read is rejected rather than being read without bound.
    const bytes = Buffer.alloc(before.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    if (bytesRead > MAX_INPUT_BYTES || bytesRead > before.size || after.size !== before.size) {
      throw new BuzzEvidenceError(
        'input_changed_during_read',
        'Input changed while being read; retry with a stable file.',
      );
    }
    return JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally {
    await handle.close();
  }
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }

  const inputPath = resolve(args.input);
  const parsed = await readBoundedJsonFile(inputPath);
  const events = Array.isArray(parsed) ? parsed : parsed.events;
  const bundle = compileBuzzEvidenceBundle({
    events,
    relay_url: args.relay_url || parsed.relay_url,
    community_ref: args.community_ref || parsed.community_ref,
  }, {
    content_policy: args.content_policy,
  });
  const output = `${JSON.stringify(bundle, null, 2)}\n`;
  if (args.out) await writeFile(resolve(args.out), output, 'utf8');
  else process.stdout.write(output);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    const code = error instanceof BuzzEvidenceError ? error.code : 'cli_error';
    process.stderr.write(`agoragentic-buzz-evidence: ${code}: ${error.message}\n`);
    process.exitCode = code === 'cli_error' ? 2 : 1;
  });
}
