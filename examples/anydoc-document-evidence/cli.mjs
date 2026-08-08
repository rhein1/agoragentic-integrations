#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { convertFileToEvidence, AnyDocEvidenceError } from './agoragentic-anydoc.mjs';

function usage() {
  return `Usage:
  node cli.mjs <document> [--format <format>] [--out <file>]
                         [--max-bytes <n>] [--max-markdown-chars <n>]
                         [--chunk-chars <n>] [--max-evidence-units <n>]
                         [--parser-timeout-ms <n>] [--parser-memory-mb <n>]
                         [--markdown-only]

Converts a local document with Firecrawl AnyDoc and emits a bounded
Agoragentic evidence handoff. The adapter makes no network request and guards
Node network APIs in the parser child, but does not claim OS-level native
network isolation. No payment, publication, deployment, memory write, or trust
mutation is performed.
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
    else if (value === '--chunk-chars') options.chunkChars = Number(args.shift());
    else if (value === '--max-evidence-units') options.maxEvidenceUnits = Number(args.shift());
    else if (value === '--parser-timeout-ms') options.parserTimeoutMs = Number(args.shift());
    else if (value === '--parser-memory-mb') options.parserMemoryMb = Number(args.shift());
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
