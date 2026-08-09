#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildConformanceReceipt,
  readJson,
  renderConformanceJUnit,
  runConformanceSuite,
} from '../src/conformance.mjs';

const packageRoot = new URL('../', import.meta.url);

function usage() {
  console.error('Usage: run-conformance [--target-module <path>] [--target-name <name>] [--target-version <version>] [--target-commit <commit>] [--json <path>] [--junit <path>] [--receipt <path>]');
}

function args(argv) {
  const output = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) throw new TypeError('arguments must be --key value pairs');
    output[key.slice(2)] = value;
  }
  return output;
}

async function write(pathname, contents) {
  await mkdir(path.dirname(path.resolve(pathname)), { recursive: true });
  await writeFile(pathname, contents, 'utf8');
}

async function main() {
  const options = args(process.argv.slice(2));
  const manifest = await readJson(new URL('conformance/manifest.v1.json', packageRoot));
  const vectorSet = await readJson(new URL('conformance/vectors.v1.json', packageRoot));
  let evaluate;
  if (options['target-module']) {
    const module = await import(pathToFileURL(path.resolve(options['target-module'])).href);
    evaluate = module.evaluateTransactionAssuranceVector;
    if (typeof evaluate !== 'function') {
      throw new TypeError('target module must export evaluateTransactionAssuranceVector');
    }
  }
  const report = await runConformanceSuite({
    manifest,
    vectorSet,
    ...(evaluate ? { evaluate } : {}),
    target: {
      name: options['target-name'] || 'agoragentic-reference-evaluator',
      version: options['target-version'] || manifest.suite_version,
      commit: options['target-commit'] || 'local-uncommitted',
    },
  });
  const receipt = buildConformanceReceipt({ manifest, vectorSet, report });
  if (options.json) await write(options.json, `${JSON.stringify(report, null, 2)}\n`);
  if (options.junit) await write(options.junit, renderConformanceJUnit(report));
  if (options.receipt) await write(options.receipt, `${JSON.stringify(receipt, null, 2)}\n`);
  if (!options.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.all_passed ? 0 : 1;
}

main().catch((error) => {
  usage();
  console.error(error.message);
  process.exitCode = 2;
});
