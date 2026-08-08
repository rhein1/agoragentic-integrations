#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  BuzzEvidenceError,
  compileBuzzEvidenceBundle,
} from './buzz-event-evidence.mjs';

const MAX_INPUT_BYTES = 4 * 1024 * 1024;

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

function parseArgs(argv) {
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

try {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const inputPath = resolve(args.input);
  const bytes = await readFile(inputPath);
  if (bytes.byteLength > MAX_INPUT_BYTES) {
    throw new BuzzEvidenceError(
      'input_too_large',
      `Input JSON exceeds the ${MAX_INPUT_BYTES}-byte CLI limit.`,
    );
  }
  const parsed = JSON.parse(bytes.toString('utf8'));
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
} catch (error) {
  const code = error instanceof BuzzEvidenceError ? error.code : 'cli_error';
  process.stderr.write(`agoragentic-buzz-evidence: ${code}: ${error.message}\n`);
  process.exit(code === 'cli_error' ? 2 : 1);
}
