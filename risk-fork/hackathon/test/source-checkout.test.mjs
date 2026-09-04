import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  cp,
  lstat,
  mkdtemp,
  readFile,
  rm,
  symlink,
  unlink,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const riskForkRoot = path.resolve(packageRoot, '..');
const repositoryRoot = path.resolve(riskForkRoot, '..');
const installCommand = 'npm --prefix risk-fork ci --ignore-scripts --no-audit --no-fund';

function runNode(args, { cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env: {},
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, 'utf8') > 1024 * 1024) child.kill();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr, 'utf8') > 1024 * 1024) child.kill();
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

test('source-checkout docs require the locked install while verified kits require no install', async () => {
  const documents = [
    path.join(repositoryRoot, 'README.md'),
    path.join(packageRoot, 'README.md'),
    path.join(packageRoot, 'docs', 'QUICKSTART.md'),
    path.join(riskForkRoot, 'discovery', 'skill.md'),
  ];
  for (const document of documents) {
    const text = await readFile(document, 'utf8');
    assert.match(text, new RegExp(installCommand.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(text, /verified offline kit/i);
    assert.match(text, /(?:needs? no install|do not run\s+`npm install` or `npm ci`)/i);
  }
  for (const machineSurface of [
    path.join(packageRoot, 'demo-status.json'),
    path.join(riskForkRoot, 'discovery', 'risk-fork-capability.json'),
  ]) {
    const value = JSON.parse(await readFile(machineSurface, 'utf8'));
    assert.equal(
      value.configuration.client_verification_details.codex,
      'codex_config_generated_not_live_client_verified',
    );
  }
});

test('a clean source copy starts after the locked local dependency tree is made available without network', async (t) => {
  const sourceModules = path.join(riskForkRoot, 'node_modules');
  const moduleInfo = await lstat(sourceModules);
  assert.equal(moduleInfo.isDirectory(), true, 'run the documented locked install before this test');

  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-clean-source-'));
  const copyRoot = path.join(parent, 'risk-fork');
  const copiedModules = path.join(copyRoot, 'node_modules');
  let modulesLinked = false;
  t.after(async () => {
    if (modulesLinked) await unlink(copiedModules).catch(() => {});
    await rm(parent, { recursive: true, force: true });
  });

  await cp(riskForkRoot, copyRoot, {
    recursive: true,
    filter: (source) => path.resolve(source) !== path.resolve(sourceModules),
  });
  await assert.rejects(lstat(copiedModules), (error) => error?.code === 'ENOENT');
  await symlink(sourceModules, copiedModules, process.platform === 'win32' ? 'junction' : 'dir');
  modulesLinked = true;

  const entrypoint = path.join(copyRoot, 'hackathon', 'bin', 'risk-fork-demo.mjs');
  const result = await runNode([entrypoint, 'doctor'], { cwd: parent });
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stderr, '');
  const output = JSON.parse(result.stdout);
  assert.equal(output.demo_only, true);
  assert.equal(output.local_protocol_simulator, true);
  assert.equal(output.provider_calls, 0);
  assert.equal(output.network_used, false);
  assert.equal(output.credentials_used, false);
  assert.equal(output.clean_commit_performed, false);
});
