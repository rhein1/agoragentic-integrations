#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { convertFileToEvidence, AnyDocEvidenceError } from './agoragentic-anydoc.mjs';

function usage() {
  return `Usage:
  node cli.mjs <document> [--format <format>] [--out <file>]
                         [--max-bytes <n>] [--max-markdown-chars <n>]
                         [--markdown-only]

Converts a local document with Firecrawl AnyDoc and emits a bounded
Agoragentic evidence handoff. No network, payment, publication, deployment,
memory write, or trust mutation is performed by the adapter.
`;
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  let file = null;
  let out = null;
  let markdownOnly = false;

  while (args.length > 0) {
    const value = args.shift();
    if (value === '--help' || value === '-h') return { help: true };
    if (value === '--format') options.format = args.shift();
    else if (value === '--out' || value === '-o') out = args.shift();
    else if (value === '--max-bytes') options.maxInputBytes = Number(args.shift());
    else if (value === '--max-markdown-chars') options.maxMarkdownChars = Number(args.shift());
    else if (value === '--markdown-only') markdownOnly = true;
    else if (String(value).startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else if (!file) file = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }

  if (!file) throw new Error('A document path is required.');
  return { file, out, markdownOnly, options };
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const result = await convertFileToEvidence(resolve(parsed.file), parsed.options);
  const body = parsed.markdownOnly
    ? result.output.markdown
    : `${JSON.stringify(result, null, 2)}\n`;

  if (parsed.out) {
    await writeFile(resolve(parsed.out), body, 'utf8');
  } else {
    process.stdout.write(body);
  }
} catch (error) {
  const code = error instanceof AnyDocEvidenceError ? error.code : 'usage_error';
  process.stderr.write(`agoragentic-anydoc: ${code}: ${error.message}\n`);
  process.exit(code === 'usage_error' ? 2 : 1);
}
