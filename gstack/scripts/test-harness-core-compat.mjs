#!/usr/bin/env node
// Clean-room compatibility proof against the exact published Harness Core package.
//
// The temporary install may use the npm registry. The bridge test itself remains
// local, no-spend, and unable to run gstack or call a provider.

import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const gstackRoot = resolve(here, '..');
const npmCli = process.env.npm_execpath
  || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
const expectedPublishedVersion = '0.3.1';
const expectedPackage = `agoragentic-harness-core@${expectedPublishedVersion}`;

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
  work = await mkdtemp(join(tmpdir(), 'agoragentic-gstack-harness-core-compat-'));
  const consumer = join(work, 'consumer');
  await mkdir(consumer);
  await copyBridgeConsumer(consumer);

  runNpm([
    'install',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--package-lock=false',
    expectedPackage,
  ], { cwd: consumer });

  const installed = await readJson(join(consumer, 'node_modules', 'agoragentic-harness-core', 'package.json'));
  assert(installed.name === 'agoragentic-harness-core', 'Temporary consumer installed an unexpected package.');
  assert(installed.version === expectedPublishedVersion, `Temporary consumer did not install Harness Core ${expectedPublishedVersion}.`);
  assert(
    installed.repository?.url === 'git+https://github.com/rhein1/agoragentic-harness-core.git',
    'Published Harness Core repository metadata is not standalone.',
  );
  for (const cli of [
    'agora-harness',
    'agoragentic-harness',
    'agoragentic-harness-core',
    'agoragentic-memory-skillopt',
  ]) {
    assert(installed.bin?.[cli], `Published Harness Core is missing the ${cli} CLI alias.`);
  }

  run(process.execPath, ['--test', 'test.mjs'], {
    cwd: consumer,
    env: {
      ...process.env,
      AGORAGENTIC_HARNESS_CORE_EXPECTED_VERSION: expectedPublishedVersion,
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
      source: 'published_npm',
      repository: installed.repository.url,
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
