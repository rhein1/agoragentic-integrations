#!/usr/bin/env node

import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  attachEvaluationEvidenceToReceipt,
  normalizeSkillOptSleepReport,
} from '../src/evaluations/index.mjs';
import { buildSkillOptTaskDraft } from '../src/memory-skillopt.mjs';

function usage() {
  console.error([
    'Usage:',
    '  agoragentic-memory-skillopt export-tasks --memory-export <path> --selection <path> --output <path>',
    '  agoragentic-memory-skillopt attach-report --report <path> --receipt <path> --producer-version <version> --source-revision <revision> --analyzed-revision <id> --output <path>',
  ].join('\n'));
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['export-tasks', 'attach-report'].includes(command)) throw new TypeError('unsupported command');
  if (rest.length % 2 !== 0) throw new TypeError('arguments must be --key value pairs');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) throw new TypeError('arguments must be --key value pairs');
    const key = flag.slice(2);
    if (Object.hasOwn(options, key)) throw new TypeError(`duplicate option: --${key}`);
    options[key] = value;
  }
  const allowed = command === 'export-tasks'
    ? new Set(['memory-export', 'selection', 'output'])
    : new Set(['report', 'receipt', 'producer-version', 'source-revision', 'analyzed-revision', 'output']);
  for (const key of Object.keys(options)) if (!allowed.has(key)) throw new TypeError(`unknown option: --${key}`);
  for (const key of allowed) if (!options[key]) throw new TypeError(`missing option: --${key}`);
  return { command, options };
}

async function readJsonFile(filename, maximum = 4 * 1024 * 1024) {
  const stat = await lstat(filename);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new TypeError(`${filename} must be a regular non-symlink file`);
  if (stat.size < 2 || stat.size > maximum) throw new RangeError(`${filename} has an unsupported size`);
  return JSON.parse(await readFile(filename, 'utf8'));
}

async function writeJsonExclusive(filename, payload) {
  const destination = path.resolve(filename);
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.tmp-${process.pid}`;
  try {
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await link(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    if (error.code === 'EEXIST') throw new Error(`output already exists: ${destination}`);
    throw error;
  }
  await rm(temporary, { force: true });
  return destination;
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === 'export-tasks') {
    const [memoryExport, selection] = await Promise.all([
      readJsonFile(options['memory-export']),
      readJsonFile(options.selection, 128 * 1024),
    ]);
    const draft = buildSkillOptTaskDraft(memoryExport, selection);
    const output = await writeJsonExclusive(options.output, draft);
    process.stdout.write(`${JSON.stringify({ ok: true, command, output, task_count: draft.tasks.length, reviewed: false })}\n`);
    return;
  }

  const [report, receipt] = await Promise.all([
    readJsonFile(options.report),
    readJsonFile(options.receipt),
  ]);
  const evaluation = normalizeSkillOptSleepReport(report, {
    producer_version: options['producer-version'],
    source_revision: options['source-revision'],
    analyzed_revision: options['analyzed-revision'],
    source_ref: path.basename(options.report),
  });
  const attached = attachEvaluationEvidenceToReceipt(receipt, evaluation);
  const output = await writeJsonExclusive(options.output, attached);
  process.stdout.write(`${JSON.stringify({ ok: true, command, output, result: evaluation.result, receipt_status: attached.status })}\n`);
}

main().catch((error) => {
  usage();
  console.error(error.message);
  process.exitCode = 1;
});
