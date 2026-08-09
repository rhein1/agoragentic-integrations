#!/usr/bin/env node
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { convertFileToEvidence, AnyDocEvidenceError } from './agoragentic-anydoc.mjs';

function usage() {
  return `Usage:
  node cli.mjs <document> [--format <format>] [--out <file>]
                         [--max-bytes <n>] [--max-markdown-chars <n>]
                         [--chunk-chars <n>] [--max-evidence-units <n>]
                         [--parser-timeout-ms <n>] [--parser-memory-mb <n>]
                         [--no-structure] [--markdown-only]

Converts one local document with the pinned Firecrawl AnyDoc package and emits
a bounded Agoragentic evidence handoff. Parsing runs in a sanitized, killable
child with Node permission and network-API guards. Those guards are not native
syscall isolation; use an OS network sandbox for sensitive untrusted files.
No payment, publication, deployment, memory write, or trust mutation is
performed by the adapter.
`;
}

function takeValue(args, option) {
  if (args.length === 0 || String(args[0]).startsWith('-')) {
    throw new Error(`${option} requires a value.`);
  }
  return args.shift();
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
    if (value === '--format') options.format = takeValue(args, value);
    else if (value === '--out' || value === '-o') out = takeValue(args, value);
    else if (value === '--max-bytes') options.maxInputBytes = Number(takeValue(args, value));
    else if (value === '--max-markdown-chars') options.maxMarkdownChars = Number(takeValue(args, value));
    else if (value === '--chunk-chars') options.chunkChars = Number(takeValue(args, value));
    else if (value === '--max-evidence-units') options.maxEvidenceUnits = Number(takeValue(args, value));
    else if (value === '--parser-timeout-ms') options.parserTimeoutMs = Number(takeValue(args, value));
    else if (value === '--parser-memory-mb') options.parserMemoryMb = Number(takeValue(args, value));
    else if (value === '--no-structure') options.inspectStructure = false;
    else if (value === '--markdown-only') markdownOnly = true;
    else if (String(value).startsWith('-')) throw new Error(`Unknown option: ${value}`);
    else if (!file) file = value;
    else throw new Error(`Unexpected argument: ${value}`);
  }

  if (!file) throw new Error('A document path is required.');
  return { file, out, markdownOnly, options };
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function openOutputWithoutTruncating(outputPath) {
  const flags = constants.O_WRONLY | (constants.O_NOFOLLOW || 0);
  try {
    return await open(outputPath, flags);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    try {
      return await open(
        outputPath,
        flags | constants.O_CREAT | constants.O_EXCL,
        0o600,
      );
    } catch (createError) {
      if (createError?.code === 'EEXIST') return open(outputPath, flags);
      throw createError;
    }
  }
}

async function writeOutputSafely(inputPath, outputPath, body) {
  let handle;
  try {
    const sourceStat = await stat(inputPath);
    handle = await openOutputWithoutTruncating(outputPath);
    const outputStat = await handle.stat();
    if (sameFileIdentity(sourceStat, outputStat)) {
      throw new AnyDocEvidenceError(
        'unsafe_output_path',
        'The output path must not refer to the source document.',
      );
    }
    await handle.truncate(0);
    await handle.writeFile(body, 'utf8');
  } catch (error) {
    if (error instanceof AnyDocEvidenceError) throw error;
    throw new AnyDocEvidenceError(
      'output_write_failed',
      'The output file could not be written safely.',
      { cause: error, causeCode: error?.code || null },
    );
  } finally {
    try {
      await handle?.close();
    } catch {
      // The write result or original write error remains authoritative.
    }
  }
}

try {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(usage());
    process.exit(0);
  }

  const inputPath = resolve(parsed.file);
  const outputPath = parsed.out ? resolve(parsed.out) : null;
  if (outputPath && samePath(inputPath, outputPath)) {
    throw new AnyDocEvidenceError('unsafe_output_path', 'The output path must not overwrite the source document.');
  }

  const result = await convertFileToEvidence(inputPath, parsed.options);
  if (parsed.markdownOnly && !result.output.completeness.complete) {
    throw new AnyDocEvidenceError(
      'incomplete_markdown',
      `Markdown-only output is blocked because parse completeness failed: ${result.output.completeness.blockers.join(', ')}.`,
    );
  }
  if (parsed.markdownOnly) {
    process.stderr.write('agoragentic-anydoc: warning: Markdown is not source-exact; evidence metadata and semantic-risk warnings are omitted.\n');
  }

  const body = parsed.markdownOnly
    ? result.output.markdown
    : `${JSON.stringify(result, null, 2)}\n`;

  if (outputPath) {
    await writeOutputSafely(inputPath, outputPath, body);
  } else {
    process.stdout.write(body);
  }
} catch (error) {
  const code = error instanceof AnyDocEvidenceError ? error.code : 'usage_error';
  process.stderr.write(`agoragentic-anydoc: ${code}: ${error.message}\n`);
  process.exit(code === 'usage_error' ? 2 : 1);
}
