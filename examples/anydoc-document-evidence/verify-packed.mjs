#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const npmCli = process.env.npm_execpath
  || join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
if (!existsSync(npmCli)) throw new Error('Could not locate npm-cli.js for packed-artifact verification.');
const requiredFiles = [
  'LICENSE',
  'README.md',
  'SKILL.md',
  'agoragentic-anydoc.mjs',
  'cli.mjs',
  'network-deny.mjs',
  'parser-worker.mjs',
  'test.mjs',
  'test-fixtures/fake-anydoc.mjs',
  'smoke-anydoc.mjs',
  'verify-packed.mjs',
  'conformance/README.md',
  'conformance/cases.json',
  'conformance/generate-fixtures.py',
  'conformance/requirements.in',
  'conformance/requirements.txt',
  'conformance/run-conformance.mjs',
  'listing-candidates.json',
  'package.json',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}.`);
  }
  return result;
}

const root = await mkdtemp(join(tmpdir(), 'agoragentic-anydoc-pack-'));
const packDir = join(root, 'pack');
const installDir = join(root, 'install');

try {
  await mkdir(packDir);
  await mkdir(installDir);
  const packed = run(process.execPath, [npmCli, 'pack', '--json', '--pack-destination', packDir], { capture: true });
  const metadata = JSON.parse(packed.stdout);
  assertPackMetadata(metadata);
  const tarball = join(packDir, metadata[0].filename);

  await writeFile(join(installDir, 'package.json'), '{"name":"anydoc-pack-verifier","private":true}\n', 'utf8');
  run(process.execPath, [npmCli, 'install', '--no-audit', '--no-fund', tarball], { cwd: installDir });
  const packageDir = join(installDir, 'node_modules', '@agoragentic', 'anydoc-document-evidence');
  const installedPackage = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
  if (installedPackage.version !== metadata[0].version) {
    throw new Error('Installed packed version does not match npm pack metadata.');
  }
  run(process.execPath, [npmCli, 'run', 'check', '--prefix', packageDir]);
  run(process.execPath, [npmCli, 'test', '--prefix', packageDir]);
  run(process.execPath, [npmCli, 'run', 'smoke:anydoc', '--prefix', packageDir]);
  console.log(JSON.stringify({
    ok: true,
    filename: metadata[0].filename,
    integrity: metadata[0].integrity,
    files_verified: requiredFiles.length,
    installed_version: installedPackage.version,
  }));
} finally {
  await rm(root, { recursive: true, force: true });
}

function assertPackMetadata(metadata) {
  if (!Array.isArray(metadata) || metadata.length !== 1) {
    throw new Error('npm pack did not return exactly one package record.');
  }
  if (!/^sha512-[A-Za-z0-9+/=]+$/.test(metadata[0].integrity || '')) {
    throw new Error('npm pack did not return a SHA-512 integrity value.');
  }
  const files = new Set((metadata[0].files || []).map((entry) => entry.path));
  for (const file of requiredFiles) {
    if (!files.has(file)) throw new Error(`Packed artifact is missing ${file}.`);
  }
}
