import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';

import { sha256Ref } from '../../src/index.mjs';
import { getDefaultDemoRoot, verifyDemoEnvelope } from '../src/demo-engine.mjs';
import {
  initializeOwnedDemoRoot,
  inspectOwnedDemoTree,
  openOwnedDemoRoot,
  removeOwnedDemoEntry,
  resolveOwnedDemoPath,
} from '../src/security.mjs';

const execFileAsync = promisify(execFile);
const testRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testRoot, '..', '..', '..');
const entrypoint = path.resolve(testRoot, '..', 'bin', 'risk-fork-demo.mjs');

function minimalEnvironment(extra = {}) {
  return {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    ...extra,
  };
}

async function cliWithEnvironment(extraEnvironment, ...args) {
  try {
    const result = await execFileAsync(process.execPath, [entrypoint, ...args], {
      cwd: repositoryRoot,
      env: minimalEnvironment(extraEnvironment),
      windowsHide: true,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, value: JSON.parse(result.stdout), stderr: result.stderr };
  } catch (error) {
    if (typeof error?.stdout === 'string' && error.stdout.trim()) {
      return { code: error.code, value: JSON.parse(error.stdout), stderr: error.stderr };
    }
    throw error;
  }
}

async function cli(...args) {
  return cliWithEnvironment({}, ...args);
}

function cliActiveLock(handle, {
  runId,
  pid,
  createdAt,
  lockId = `lock_${'d'.repeat(32)}`,
}) {
  const base = {
    schema: 'agoragentic.risk-fork.hackathon-active-lock.v1',
    root_id: handle.root_id,
    lock_id: lockId,
    run_id: runId,
    pid,
    created_at: createdAt,
    lock_hash: null,
  };
  return { ...base, lock_hash: sha256Ref(base) };
}

async function writeCliActiveLock(handle, record) {
  const lock = await resolveOwnedDemoPath(handle, '.active-run.lock');
  await writeFile(lock.absolute_path, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

test('CLI doctor/plan are read-only and HIGH run plus cleanup are truth-bearing', async () => {
  await cli('cleanup');
  const doctor = await cli('doctor');
  assert.equal(doctor.code, 0);
  assert.equal(doctor.value.status, 'ready_for_local_demo');
  assert.equal(doctor.value.node.supported_range, '>=20');
  assert.equal(doctor.value.owned_root.absolute_path_redacted, true);
  assert.equal(doctor.value.writes_performed, false);
  assert.doesNotMatch(JSON.stringify(doctor.value), /[A-Za-z]:[\\/]Users[\\/]/i);

  const plan = await cli('plan', '--scenario', 'high-filesystem-write');
  assert.equal(plan.code, 0);
  assert.equal(plan.value.decision.level, 'HIGH');
  assert.equal(plan.value.writes_performed, false);

  const run = await cli('run', '--scenario', 'high-filesystem-write');
  assert.equal(run.code, 0);
  assert.equal(run.value.final_state, 'prepared_not_committed');
  assert.equal(run.value.core_receipt_verified, true);
  assert.equal(run.value.cleanup.status, 'verified');
  assert.equal(run.value.recorder.status, 'verified_local_record');
  assert.equal(run.value.clean_commit_performed, false);

  const cleanup = await cli('cleanup');
  assert.equal(cleanup.code, 0);
  assert.equal(cleanup.value.cleanup.status, 'verified');
});

test('verify-offline-kit composes the same Node support evidence before manifest verification', async () => {
  const verification = await cli('verify-offline-kit');
  assert.equal(verification.code, 2);
  assert.equal(verification.value.status, 'not_inside_offline_kit');
  assert.equal(verification.value.verified, false);
  assert.equal(verification.value.node.supported_range, '>=20');
  assert.equal(verification.value.node.supported, true);
});

test('CLI config preview is write-free and --yes writes only a cleanup-owned review artifact', async (t) => {
  const isolatedTemp = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-config-cli-'));
  t.after(() => rm(isolatedTemp, { recursive: true, force: true }));
  const isolatedEnvironment = {
    TEMP: isolatedTemp,
    TMP: isolatedTemp,
    TMPDIR: isolatedTemp,
  };
  const isolatedRoot = path.join(isolatedTemp, path.basename(getDefaultDemoRoot()));
  await assert.rejects(lstat(isolatedRoot), { code: 'ENOENT' });

  const preview = await cliWithEnvironment(isolatedEnvironment, 'config', '--client', 'codex');
  assert.equal(preview.code, 0);
  assert.equal(preview.value.mode, 'preview');
  assert.equal(preview.value.writes_performed, false);
  assert.equal(preview.value.configuration.command, 'node');
  assert.doesNotMatch(preview.value.configuration.content, /\bnpx(?:\.cmd)?\b/i);
  await assert.rejects(lstat(isolatedRoot), { code: 'ENOENT' });

  const written = await cliWithEnvironment(
    isolatedEnvironment,
    'config',
    '--client',
    'codex',
    '--yes',
  );
  assert.equal(written.code, 0);
  assert.equal(written.value.mode, 'written_to_owned_demo_root');
  assert.equal(written.value.configuration.output_ref, 'owned-demo-root:configs/codex-risk-fork-demo.toml');
  const ownedRoot = await openOwnedDemoRoot(isolatedRoot);
  const afterWrite = await inspectOwnedDemoTree(ownedRoot);
  assert.deepEqual(
    afterWrite.entries.map(({ path: entryPath, type }) => [entryPath, type]),
    [
      ['configs', 'directory'],
      ['configs/codex-risk-fork-demo.toml', 'file'],
    ],
  );
  const writtenConfig = await resolveOwnedDemoPath(
    ownedRoot,
    'configs/codex-risk-fork-demo.toml',
    { mustExist: true, expectedType: 'file' },
  );
  assert.equal(
    (await readFile(writtenConfig.absolute_path, 'utf8')).includes(JSON.stringify(entrypoint)),
    true,
  );
  const cleanup = await cliWithEnvironment(isolatedEnvironment, 'cleanup');
  assert.equal(cleanup.value.cleanup.status, 'verified');
  const cleanedRoot = await openOwnedDemoRoot(isolatedRoot);
  assert.deepEqual((await inspectOwnedDemoTree(cleanedRoot)).entries, []);
});

test('CLI interruption invokes shared abort/cleanup and exits nonzero', async () => {
  await cli('cleanup');
  const moduleUrl = pathToFileURL(entrypoint).href;
  const engineModuleUrl = pathToFileURL(path.resolve(testRoot, '..', 'src', 'demo-engine.mjs')).href;
  const securityModuleUrl = pathToFileURL(path.resolve(testRoot, '..', 'src', 'security.mjs')).href;
  const source = `
    import { runCli } from ${JSON.stringify(moduleUrl)};
    import { getDefaultDemoRoot } from ${JSON.stringify(engineModuleUrl)};
    import { inspectOwnedDemoTree, openOwnedDemoRoot } from ${JSON.stringify(securityModuleUrl)};
    const pending = runCli(['run', '--scenario', 'attack-timeout']);
    const deadline = Date.now() + 5000;
    let allocationObserved = false;
    while (!allocationObserved && Date.now() < deadline) {
      try {
        const handle = await openOwnedDemoRoot(getDefaultDemoRoot());
        const inventory = await inspectOwnedDemoTree(handle, { maxFiles: 100, maxBytes: 64 * 1024 * 1024 });
        allocationObserved = inventory.entries.some((entry) => (
          entry.type === 'directory'
          && entry.path.startsWith('runs/run_')
          && entry.path.endsWith('/adapter/forks')
        ));
      } catch {}
      if (!allocationObserved) await new Promise((resolve) => setTimeout(resolve, 5));
    }
    if (!allocationObserved) throw new Error('Marker-bound active allocation was not observed');
    process.emit('SIGINT');
    const result = await pending;
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repositoryRoot,
    env: minimalEnvironment(),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.final_state, 'blocked');
  assert.equal(result.exit_code, 2);
  assert.equal(result.interruption.signal, 'SIGINT');
  assert.equal(result.interruption.cleanup.status, 'verified');
  assert.equal(result.interruption.owned_run_cleanup.status, 'verified_absent');
  assert.equal(result.owned_run_cleanup.status, 'verified_absent');
  assert.equal(result.final_state, result.demo_receipt.final_state);
  assert.equal(result.exit_code, result.demo_receipt.exit_code);
  assert.equal(result.cleanup.status, result.demo_receipt.cleanup_status);
  assert.equal(verifyDemoEnvelope(result.demo_receipt), true);
  assert.equal((await cli('cleanup')).value.cleanup.status, 'verified');
});

test('CLI pre-allocation interruption truthfully reports not_applicable without run artifacts', async () => {
  await cli('cleanup');
  const root = getDefaultDemoRoot();
  const handle = await initializeOwnedDemoRoot(root);
  const moduleUrl = pathToFileURL(entrypoint).href;
  const source = `
    import { runCli } from ${JSON.stringify(moduleUrl)};
    const pending = runCli(['run', '--scenario', 'attack-timeout']);
    process.emit('SIGINT');
    const result = await pending;
    process.stdout.write(JSON.stringify(result));
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: repositoryRoot,
    env: minimalEnvironment(),
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const result = JSON.parse(stdout);
  assert.equal(result.final_state, 'blocked');
  assert.equal(result.exit_code, 2);
  assert.equal(result.interruption.signal, 'SIGINT');
  assert.equal(result.interruption.cleanup.status, 'not_applicable');
  assert.equal(result.interruption.owned_run_cleanup.status, 'not_applicable');
  assert.equal(result.owned_run_cleanup.status, 'not_applicable');
  assert.equal(result.final_state, result.demo_receipt.final_state);
  assert.equal(result.exit_code, result.demo_receipt.exit_code);
  assert.equal(result.cleanup.status, result.demo_receipt.cleanup_status);
  assert.equal(verifyDemoEnvelope(result.demo_receipt), true);
  assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
  assert.equal((await resolveOwnedDemoPath(handle, '.cleanup-recovery.lock')).exists, false);
  assert.equal((await resolveOwnedDemoPath(handle, 'runs')).exists, false);
  const inventory = await inspectOwnedDemoTree(handle, {
    maxFiles: 20,
    maxBytes: 4 * 1024 * 1024,
  });
  assert.equal(inventory.entries.some((entry) => entry.path.startsWith('runs/')), false);
  assert.equal((await cli('cleanup')).value.cleanup.status, 'verified');
});

test('CLI recorder failure preserves the finalized core outcome and receipt binding', async () => {
  await cli('cleanup');
  const handle = await initializeOwnedDemoRoot(getDefaultDemoRoot());
  const records = await resolveOwnedDemoPath(handle, 'records');
  const collisionEvidence = 'synthetic-recorder-type-collision\n';
  await writeFile(records.absolute_path, collisionEvidence, { flag: 'wx', mode: 0o600 });
  try {
    const result = await cli('run', '--scenario', 'low-read-only');
    assert.equal(result.code, 0);
    assert.equal(result.value.final_state, 'direct_permitted');
    assert.equal(result.value.exit_code, 0);
    assert.equal(result.value.recorder.status, 'failed');
    assert.equal(result.value.delivery_status, 'recorder_failed_core_outcome_preserved');
    assert.equal(result.value.final_state, result.value.demo_receipt.final_state);
    assert.equal(result.value.exit_code, result.value.demo_receipt.exit_code);
    assert.equal(result.value.cleanup.status, result.value.demo_receipt.cleanup_status);
    assert.equal(verifyDemoEnvelope(result.value.demo_receipt), true);
    assert.equal(await readFile(records.absolute_path, 'utf8'), collisionEvidence);
  } finally {
    assert.equal((await cli('cleanup')).value.cleanup.status, 'verified');
  }
});

test('actual CLI cleanup refuses a live lock, then recovers dead aged crash residue and retries cleanly', async () => {
  await cli('cleanup');
  const root = getDefaultDemoRoot();
  const outside = path.join(path.dirname(root), `risk-fork-cli-outside-${process.pid}.txt`);
  try {
    const handle = await initializeOwnedDemoRoot(root);
    const liveRunId = `run_${'4'.repeat(24)}`;
    await writeCliActiveLock(handle, cliActiveLock(handle, {
      runId: liveRunId,
      pid: process.pid,
      createdAt: '2000-01-01T00:00:00.000Z',
    }));
    const live = await cli('cleanup');
    assert.equal(live.code, 2);
    assert.equal(live.value.cleanup.status, 'unknown');
    assert.equal(live.value.failure.code, 'DEMO_ACTIVE_LOCK_LIVE');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, true);

    await removeOwnedDemoEntry(handle, '.active-run.lock');
    const crashedRunId = `run_${'5'.repeat(24)}`;
    for (const relative of [
      `runs/${crashedRunId}/adapter/forks/fork-residue`,
      `runs/${crashedRunId}/adapter/savepoints/savepoint-residue`,
    ]) {
      const resolved = await resolveOwnedDemoPath(handle, relative);
      await mkdir(resolved.absolute_path, { recursive: true, mode: 0o700 });
    }
    await writeCliActiveLock(handle, cliActiveLock(handle, {
      runId: crashedRunId,
      pid: 2_147_483_646,
      createdAt: '2000-01-01T00:00:00.000Z',
      lockId: `lock_${'e'.repeat(32)}`,
    }));
    await writeFile(outside, 'must survive CLI cleanup\n', { mode: 0o600 });

    const recovered = await cli('cleanup');
    assert.equal(recovered.code, 0);
    assert.equal(recovered.value.cleanup.status, 'verified');
    assert.equal(recovered.value.cleanup.stale_lock_recovered, true);
    assert.equal(recovered.value.cleanup.recovered_run_id, crashedRunId);
    assert.equal(await readFile(outside, 'utf8'), 'must survive CLI cleanup\n');
    assert.equal((await resolveOwnedDemoPath(handle, '.active-run.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, '.cleanup-recovery.lock')).exists, false);
    assert.equal((await resolveOwnedDemoPath(handle, `runs/${crashedRunId}`)).exists, false);

    const retry = await cli('cleanup');
    assert.equal(retry.code, 0);
    assert.equal(retry.value.cleanup.status, 'verified');
    assert.equal(retry.value.cleanup.stale_lock_recovered, false);
  } finally {
    await rm(outside, { force: true });
    await cli('cleanup');
  }
});

test('stdio MCP handshake exposes only the four closed synthetic tools', async () => {
  const child = spawn(process.execPath, [entrypoint, 'mcp'], {
    cwd: repositoryRoot,
    env: minimalEnvironment(),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      output.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  child.stdin.end([
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    '',
  ].join('\n'));
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(code, 0);
  assert.match(output[0].result.instructions, /DEMO ONLY — LOCAL PROTOCOL SIMULATOR/);
  assert.deepEqual(output[1].result.tools.map((tool) => tool.name), [
    'risk_fork_demo_list_scenarios',
    'risk_fork_demo_plan',
    'risk_fork_demo_run',
    'risk_fork_demo_receipt',
  ]);
});
