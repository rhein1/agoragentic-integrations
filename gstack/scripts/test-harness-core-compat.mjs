#!/usr/bin/env node
// Local compatibility proof for the review-gated Harness Core candidate.
//
// This intentionally packs the sibling source package and installs it in a
// throwaway consumer. npm may resolve the package's declared dependencies
// during that setup; the bridge itself does not call the network or grant
// runtime/financial authority.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gstackRoot = resolve(here, '..');
const harnessCoreRoot = resolve(gstackRoot, '..', 'harness-core');
const npmCli = process.env.npm_execpath
  || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const expectedCandidateVersion = '0.3.0';

if (!existsSync(npmCli)) throw new Error('Could not locate npm-cli.js for packed Harness Core compatibility verification.');

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: 'pipe',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.${output ? `\n${output}` : ''}`);
  }
  return result;
}

function runNpm(args, options = {}) {
  return run(process.execPath, [npmCli, ...args], options);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

async function copyBridgeConsumer(consumer) {
  for (const file of ['gstack-harness.mjs', 'cli.mjs', 'test.mjs']) {
    await cp(join(gstackRoot, file), join(consumer, file));
  }
  await cp(join(gstackRoot, 'fixtures'), join(consumer, 'fixtures'), { recursive: true });
  await writeFile(join(consumer, 'package.json'), `${JSON.stringify({
    name: 'gstack-harness-core-compat-consumer',
    version: '0.0.0',
    private: true,
    type: 'module',
  }, null, 2)}\n`, 'utf8');
}

let work;
try {
  const harnessPackage = await readJson(join(harnessCoreRoot, 'package.json'));
  assert(harnessPackage.name === 'agoragentic-harness-core', 'Sibling Harness Core package name is unexpected.');
  assert(
    harnessPackage.version === expectedCandidateVersion,
    `Expected local Harness Core ${expectedCandidateVersion}, found ${harnessPackage.version || 'unknown'}.`,
  );

  work = await mkdtemp(join(tmpdir(), 'agoragentic-gstack-harness-core-compat-'));
  const packDir = join(work, 'pack');
  const consumer = join(work, 'consumer');
  await mkdir(packDir);
  await mkdir(consumer);

  const packResult = runNpm([
    'pack',
    '--json',
    '--ignore-scripts',
    '--pack-destination',
    packDir,
  ], { cwd: harnessCoreRoot });
  const packed = JSON.parse(packResult.stdout);
  assert(Array.isArray(packed) && packed.length === 1, 'npm pack must return exactly one Harness Core package record.');
  assert(packed[0].name === harnessPackage.name, 'Packed Harness Core package name does not match package.json.');
  assert(packed[0].version === expectedCandidateVersion, 'Packed Harness Core version is not 0.3.0.');
  const tarball = join(packDir, packed[0].filename);
  assert(existsSync(tarball), 'npm pack did not create the declared Harness Core tarball.');

  await copyBridgeConsumer(consumer);
  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    tarball,
  ], { cwd: consumer });

  const installed = await readJson(join(consumer, 'node_modules', 'agoragentic-harness-core', 'package.json'));
  assert(installed.name === harnessPackage.name, 'Temporary consumer installed an unexpected Harness Core package.');
  assert(installed.version === expectedCandidateVersion, 'Temporary consumer did not install Harness Core 0.3.0.');

  run(process.execPath, ['--test', 'test.mjs'], {
    cwd: consumer,
    env: {
      ...process.env,
      AGORAGENTIC_HARNESS_CORE_EXPECTED_VERSION: expectedCandidateVersion,
      AGORAGENTIC_NO_SPEND: '1',
      AGORAGENTIC_ALLOW_REAL_SPEND: '0',
      AGORAGENTIC_ALLOW_NETWORK_CANARIES: '0',
    },
  });

  console.log(JSON.stringify({
    ok: true,
    harness_core: {
      package: installed.name,
      version: installed.version,
      source: 'packed_local_tarball',
    },
    bridge_regression: 'passed',
    authority_boundary: {
      gstack_execution: false,
      hosted_runtime: false,
      marketplace_publication: false,
      spend: false,
    },
  }));
} finally {
  if (work) await rm(work, { recursive: true, force: true });
}
