import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

import { sha256Ref } from '../src/canonical.mjs';
import {
  __testReleaseCapturedContent,
  __testScavengeCaptureDirectories,
  __testEnumerateWorkspace,
  inspectLocalWorkspace,
  LocalReferenceRiskForkAdapter,
} from '../src/adapters/local-reference.mjs';
import { NOW, makeCapsule, makeForkIdentity } from './helpers.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function operation(filename, answer) {
  return {
    kind: 'bounded_file_batch',
    actions: [{ type: 'write', path: filename, content: `${answer}\n` }],
    commit_candidate: {
      type: 'TYPED_RESULT',
      payload: { answer },
      payload_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['answer'],
        properties: { answer: { type: 'string', maxLength: 100 } },
      },
    },
  };
}

function runnerResult(entry) {
  return {
    parsed: {
      schema: 'agoragentic.risk-fork.local-runner-result.v1',
      status: 'completed',
      network_contract: 'blocked_by_closed_operation_set_not_kernel_firewall',
      observations: [],
      commit_candidate: entry.input.operation.commit_candidate ?? null,
    },
    stdout_bytes: 128,
  };
}

function createControlledRunner() {
  const starts = [];
  return {
    starts,
    operationRunner(input) {
      const result = deferred();
      const closed = deferred();
      const terminationStarted = deferred();
      let settled = false;
      let terminateCalls = 0;
      let terminationFailure = null;
      let terminationReason = null;
      const entry = {
        input,
        termination_started: terminationStarted.promise,
        get settled() { return settled; },
        get terminate_calls() { return terminateCalls; },
        get termination_reason() { return terminationReason; },
        close() { closed.resolve(); },
        complete(value = null) {
          if (settled) return false;
          settled = true;
          closed.resolve();
          result.resolve(value ?? runnerResult(entry));
          return true;
        },
        fail(error) {
          if (settled) return false;
          settled = true;
          closed.resolve();
          result.reject(error);
          return true;
        },
        failTermination(error) { terminationFailure = error; },
        clearTerminationFailure() { terminationFailure = null; },
      };
      starts.push(entry);
      return {
        result: result.promise,
        async terminate(reason) {
          terminateCalls += 1;
          terminationReason ??= reason;
          terminationStarted.resolve();
          await closed.promise;
          if (!settled) {
            settled = true;
            result.reject(terminationReason);
          }
          if (terminationFailure) throw terminationFailure;
        },
      };
    },
  };
}

async function makeFixture(prefix, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const source = path.join(root, 'source');
  await mkdir(source);
  const adapter = new LocalReferenceRiskForkAdapter({
    baseDirectory: path.join(root, 'adapter'),
    clock: options.clock ?? (() => new Date(NOW)),
    ...(options.runnerControl ? { operationRunner: options.runnerControl.operationRunner } : {}),
  });
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  const capsule = makeCapsule({
    workspace: { snapshot_ref: 'workspace:local-concurrency', digest: inspected.workspace_digest },
  });
  const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
  const fork = await adapter.createFork({
    savepoint_ref: savepoint.savepoint_ref,
    fork_identity: makeForkIdentity(capsule),
    network_policy: { mode: 'blocked' },
    ttl_ms: options.ttlMs ?? 60_000,
  });
  return {
    adapter,
    fork,
    root,
    runnerControl: options.runnerControl ?? null,
  };
}

async function disposeFixture(fixture, { allowAdapterFailure = false } = {}) {
  for (const entry of fixture.runnerControl?.starts ?? []) entry.close();
  let disposeError = null;
  try {
    await fixture.adapter.dispose();
  } catch (error) {
    disposeError = error;
  } finally {
    await rm(fixture.root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 25,
    });
  }
  if (disposeError && !allowAdapterFailure) throw disposeError;
}

async function waitForStatus(adapter, forkRef, wanted, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evidence = await adapter.collectEvidence({ fork_ref: forkRef });
    if (evidence.status === wanted) return evidence;
    await delay(10);
  }
  throw new Error(`Fork did not reach ${wanted} within ${timeoutMs}ms`);
}

function assertEvidenceHash(evidence) {
  assert.equal(evidence.evidence_hash, sha256Ref({
    fork_ref: evidence.fork_ref,
    status: evidence.status,
    identity_hash: evidence.identity_hash,
    network_policy_hash: evidence.network_policy_hash,
    last_execution: evidence.last_execution,
  }));
}

const WINDOWS_LOCK_READY = 'RISK_FORK_TEST_LOCK_READY';
const WINDOWS_LOCK_START_TIMEOUT_MS = 45_000;
const WINDOWS_LOCK_CLOSE_TIMEOUT_MS = 15_000;
const execFileAsync = promisify(execFile);

test('capture spool cleanup migrates only aged legacy markers and scavenges stale dead-owner directories', {
  skip: process.platform === 'win32' ? 'POSIX owner-safe orphan scavenger' : false,
  timeout: 30_000,
}, async (t) => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-capture-root-'));
  t.after(() => rm(captureRoot, { recursive: true, force: true }));
  const staleDirectory = await mkdtemp(path.join(captureRoot, 'agoragentic-risk-fork-capture-'));
  const marker = path.join(staleDirectory, '.agoragentic-risk-fork-capture-v1');
  await writeFile(marker, JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v1',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
  }), { mode: 0o600 });
  await writeFile(path.join(staleDirectory, '0-00000000-0000-4000-8000-000000000000.bin'), 'orphan', { mode: 0o600 });
  await chmod(staleDirectory, 0o700);
  const old = new Date(Date.now() - (26 * 60 * 60 * 1000));
  await utimes(marker, old, old);
  await utimes(staleDirectory, old, old);

  const protectedDirectory = await mkdtemp(path.join(captureRoot, 'agoragentic-risk-fork-capture-'));
  t.after(() => Promise.all([
    rm(staleDirectory, { recursive: true, force: true }),
    rm(protectedDirectory, { recursive: true, force: true }),
  ]));
  await writeFile(path.join(protectedDirectory, 'unrelated.txt'), 'must remain', { mode: 0o600 });
  await writeFile(path.join(protectedDirectory, '.agoragentic-risk-fork-capture-v1'), JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v1',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
  }), { mode: 0o600 });
  await chmod(protectedDirectory, 0o700);
  await utimes(path.join(protectedDirectory, '.agoragentic-risk-fork-capture-v1'), old, old);

  assert.equal(await __testScavengeCaptureDirectories(captureRoot), 1);
  await assert.rejects(access(staleDirectory), (error) => error?.code === 'ENOENT');
  assert.equal(await access(path.join(protectedDirectory, 'unrelated.txt')).then(() => true), true);

  const source = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-cleanup-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  for (let index = 0; index < 5_000; index += 1) {
    await writeFile(path.join(source, `${index}.txt`), 'x');
  }
  const snapshot = await __testEnumerateWorkspace(source, {
    maxFiles: 10_000,
    maxBytes: 10_000,
    retain: true,
  });
  let timerTicks = 0;
  const timer = setInterval(() => { timerTicks += 1; }, 0);
  try {
    await __testReleaseCapturedContent(snapshot.records);
  } finally {
    clearInterval(timer);
  }
  assert.ok(timerTicks > 0, 'spool cleanup must yield between filesystem operations');
});

test('capture scavenger ignores unrelated temporary-directory lookalikes', {
  skip: process.platform === 'win32' ? 'POSIX owner-safe orphan scavenger' : false,
}, async (t) => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-capture-root-'));
  const unrelated = await mkdtemp(path.join(os.tmpdir(), 'agoragentic-risk-fork-capture-'));
  t.after(() => Promise.all([
    rm(captureRoot, { recursive: true, force: true }),
    rm(unrelated, { recursive: true, force: true }),
  ]));
  const marker = path.join(unrelated, '.agoragentic-risk-fork-capture-v1');
  await writeFile(marker, JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v1',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
  }), { mode: 0o600 });
  await chmod(unrelated, 0o700);
  const old = new Date(Date.now() - (26 * 60 * 60 * 1000));
  await utimes(marker, old, old);
  assert.equal(await __testScavengeCaptureDirectories(captureRoot), 0);
  assert.equal(await access(unrelated).then(() => true), true);
});

test('adapter instances receive distinct private capture roots', async (t) => {
  const firstRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-adapter-one-'));
  const secondRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-adapter-two-'));
  t.after(() => Promise.all([
    rm(firstRoot, { recursive: true, force: true }),
    rm(secondRoot, { recursive: true, force: true }),
  ]));
  const first = new LocalReferenceRiskForkAdapter({ baseDirectory: path.join(firstRoot, 'adapter') });
  const second = new LocalReferenceRiskForkAdapter({ baseDirectory: path.join(secondRoot, 'adapter') });
  await first.initialize();
  await second.initialize();
  assert.notEqual(first.captureRoot, second.captureRoot);
  assert.equal(await access(first.captureRoot).then(() => true), true);
  assert.equal(await access(second.captureRoot).then(() => true), true);
});

test('default adapter initialization reclaims stale capture spools from an abandoned adapter', {
  skip: process.platform === 'win32' ? 'POSIX owner-safe adapter recovery' : false,
}, async (t) => {
  const stateRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-state-root-'));
  const previousStateRoot = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateRoot;
  t.after(() => {
    if (previousStateRoot === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateRoot;
    return rm(stateRoot, { recursive: true, force: true });
  });
  const parent = path.join(stateRoot, 'agoragentic-risk-fork');
  const abandoned = path.join(parent, 'adapter-abandoned');
  const captureRoot = path.join(abandoned, 'capture-spools');
  const orphan = path.join(captureRoot, 'agoragentic-risk-fork-capture-old');
  await mkdir(orphan, { recursive: true, mode: 0o700 });
  await writeFile(path.join(abandoned, '.adapter-owner-v1'), JSON.stringify({
    schema: 'agoragentic.risk-fork.adapter-owner.v1',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
    process_instance: { boot_id: 'dead-boot', start_time: 'dead-start' },
  }), { mode: 0o600 });
  await writeFile(path.join(orphan, '.agoragentic-risk-fork-capture-v2'), JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v2',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
    process_instance: { boot_id: 'dead-boot', start_time: 'dead-start' },
  }), { mode: 0o600 });
  await writeFile(path.join(orphan, '0-00000000-0000-4000-8000-000000000000.bin'), 'orphan', { mode: 0o600 });
  await chmod(abandoned, 0o700);
  await chmod(captureRoot, 0o700);
  const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
  await utimes(path.join(abandoned, '.adapter-owner-v1'), old, old);
  await utimes(path.join(orphan, '.agoragentic-risk-fork-capture-v2'), old, old);

  const adapter = new LocalReferenceRiskForkAdapter();
  await adapter.initialize();
  assert.equal(await access(adapter.captureRoot).then(() => true), true);
  await assert.rejects(access(orphan), (error) => error?.code === 'ENOENT');
  assert.equal(await access(abandoned).then(() => true), true);
});

test('fork copy remains tracked when source spool release fails', {
  skip: process.platform === 'win32' ? 'POSIX spool permission boundary' : false,
}, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-copy-cleanup-'));
  const source = path.join(root, 'source');
  await mkdir(source);
  let cleanupCalls = 0;
  const adapter = new LocalReferenceRiskForkAdapter({
    baseDirectory: path.join(root, 'adapter'),
    clock: () => new Date(NOW),
    removeDirectory: async () => {
      cleanupCalls += 1;
      throw new Error('synthetic cleanup failure');
    },
  });
  t.after(() => {
    chmodSync(adapter.captureRoot, 0o700);
    return rm(root, { recursive: true, force: true });
  });
  await adapter.initialize();
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  const capsule = makeCapsule({
    workspace: { snapshot_ref: 'workspace:fork-cleanup', digest: inspected.workspace_digest },
  });
  const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
  adapter.clock = () => {
    chmodSync(adapter.captureRoot, 0o500);
    return new Date(NOW);
  };
  await assert.rejects(
    adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: makeForkIdentity(capsule),
      network_policy: { mode: 'blocked' },
    }),
    /EACCES|permission|synthetic cleanup failure/i,
  );
  assert.equal(cleanupCalls > 0, true);
  const pending = [...adapter.forks.values()].find((record) => record.cleanup_pending);
  assert.ok(pending, 'copied fork must remain tracked when cleanup cannot be confirmed');
});

test('adapter rejects unsafe explicit private roots', {
  skip: process.platform === 'win32' ? 'POSIX private-root mode boundary' : false,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-private-root-'));
  const target = path.join(temporary, 'target');
  const linked = path.join(temporary, 'linked');
  const linkedParent = path.join(temporary, 'linked-parent');
  t.after(() => rm(temporary, { recursive: true, force: true }));
  await mkdir(target, { mode: 0o700 });
  await chmod(target, 0o755);
  await symlink(target, linked);
  await symlink(target, linkedParent);
  await assert.rejects(
    new LocalReferenceRiskForkAdapter({ baseDirectory: target }).initialize(),
    /ownership or mode is unsafe/i,
  );
  await assert.rejects(
    new LocalReferenceRiskForkAdapter({ baseDirectory: linked }).initialize(),
    /not a real directory/i,
  );
  await assert.rejects(
    new LocalReferenceRiskForkAdapter({ baseDirectory: path.join(linkedParent, 'adapter') }).initialize(),
    /ancestor is not trusted/i,
  );
});

test('capture scavenger rescans a young orphan after the in-flight pass completes', {
  skip: process.platform === 'win32' ? 'POSIX owner-safe orphan scavenger' : false,
}, async (t) => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-capture-root-'));
  t.after(() => rm(captureRoot, { recursive: true, force: true }));
  const orphanDirectory = await mkdtemp(path.join(captureRoot, 'agoragentic-risk-fork-capture-'));
  const marker = path.join(orphanDirectory, '.agoragentic-risk-fork-capture-v2');
  const payload = path.join(orphanDirectory, '0-00000000-0000-4000-8000-000000000000.bin');
  t.after(() => rm(orphanDirectory, { recursive: true, force: true }));
  await writeFile(marker, JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v2',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
    process_instance: { boot_id: 'test-boot', start_time: 'test-start' },
  }), { mode: 0o600 });
  await writeFile(payload, 'orphan', { mode: 0o600 });
  await chmod(orphanDirectory, 0o700);
  const source = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-rescan-'));
  t.after(() => rm(source, { recursive: true, force: true }));
  await __testEnumerateWorkspace(source, { captureRoot });
  assert.equal(await access(orphanDirectory).then(() => true), true);
  const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
  await utimes(marker, old, old);
  await utimes(orphanDirectory, old, old);
  await __testEnumerateWorkspace(source, { captureRoot });
  await assert.rejects(access(orphanDirectory), (error) => error?.code === 'ENOENT');
});

test('capture scavenger reclaims a live PID whose process instance does not match', {
  skip: process.platform === 'win32' ? 'POSIX owner-safe orphan scavenger' : false,
}, async (t) => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-capture-root-'));
  t.after(() => rm(captureRoot, { recursive: true, force: true }));
  const directory = await mkdtemp(path.join(captureRoot, 'agoragentic-risk-fork-capture-'));
  const marker = path.join(directory, '.agoragentic-risk-fork-capture-v2');
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(marker, JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v2',
    token: '00000000-0000-4000-8000-000000000000',
    pid: process.pid,
    process_instance: process.platform === 'linux'
      ? { boot_id: 'wrong-boot', start_time: 'wrong-start' }
      : { start_time: 'wrong-start' },
  }), { mode: 0o600 });
  await chmod(directory, 0o700);
  const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
  await utimes(marker, old, old);
  assert.equal(await __testScavengeCaptureDirectories(captureRoot), 1);
  await assert.rejects(access(directory), (error) => error?.code === 'ENOENT');
});

test('capture scavenger lstat-falls back for unknown directory entries', {
  skip: process.platform === 'win32' ? 'POSIX special filesystem entries' : false,
}, async (t) => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-capture-root-'));
  t.after(() => rm(captureRoot, { recursive: true, force: true }));
  const unknownTopLevel = path.join(captureRoot, `agoragentic-risk-fork-capture-unknown-${randomUUID()}`);
  const directory = await mkdtemp(path.join(captureRoot, 'agoragentic-risk-fork-capture-'));
  const marker = path.join(directory, '.agoragentic-risk-fork-capture-v2');
  t.after(() => Promise.all([
    rm(unknownTopLevel, { force: true }),
    rm(directory, { recursive: true, force: true }),
  ]));
  await execFileAsync('mkfifo', [unknownTopLevel]);
  await writeFile(marker, JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v2',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
    process_instance: { boot_id: 'test-boot', start_time: 'test-start' },
  }), { mode: 0o600 });
  await execFileAsync('mkfifo', [path.join(directory, '1-00000000-0000-4000-8000-000000000000.bin')]);
  await chmod(directory, 0o700);
  const old = new Date(Date.now() - (2 * 60 * 60 * 1000));
  await utimes(marker, old, old);
  assert.equal(await __testScavengeCaptureDirectories(captureRoot), 0);
  assert.equal(await access(unknownTopLevel).then(() => true), true);
  assert.equal(await access(directory).then(() => true), true);
});

test('capture scavenger never follows a replacement marker symlink', {
  skip: process.platform === 'win32' ? 'POSIX no-follow marker boundary' : false,
}, async (t) => {
  const captureRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-capture-root-'));
  t.after(() => rm(captureRoot, { recursive: true, force: true }));
  const directory = await mkdtemp(path.join(captureRoot, 'agoragentic-risk-fork-capture-'));
  const target = path.join(os.tmpdir(), `risk-fork-marker-target-${randomUUID()}`);
  const marker = path.join(directory, '.agoragentic-risk-fork-capture-v2');
  t.after(() => Promise.all([
    rm(directory, { recursive: true, force: true }),
    rm(target, { force: true }),
  ]));
  await writeFile(target, JSON.stringify({
    schema: 'agoragentic.risk-fork.capture-directory.v2',
    token: '00000000-0000-4000-8000-000000000000',
    pid: 99_999_999,
    process_instance: { boot_id: 'test-boot', start_time: 'test-start' },
  }), { mode: 0o600 });
  await symlink(target, marker);
  await chmod(directory, 0o700);

  assert.equal(await __testScavengeCaptureDirectories(captureRoot), 0);
  assert.equal(await access(directory).then(() => true), true);
  assert.equal(await access(target).then(() => true), true);
});

test('first-entry snapshot rejection removes its capture spool directory', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-first-entry-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(path.join(source, '.git'), 'not a repository directory');
  const before = new Set((await readdir(os.tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agoragentic-risk-fork-capture-'))
    .map((entry) => entry.name));
  await assert.rejects(
    inspectLocalWorkspace({ source_workspace: source }),
    /exclude \.git metadata/i,
  );
  const after = (await readdir(os.tmpdir(), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('agoragentic-risk-fork-capture-'))
    .map((entry) => entry.name);
  assert.deepEqual(after.filter((name) => !before.has(name)), []);
});

test('local workspace rejects a FIFO without opening or blocking on it', {
  skip: process.platform === 'win32' ? 'POSIX FIFO boundary' : false,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-fifo-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await execFileAsync('mkfifo', [path.join(source, 'blocking.pipe')]);
  await assert.rejects(
    inspectLocalWorkspace({ source_workspace: source }),
    /special filesystem entry/i,
  );
});

test('local workspace falls back to lstat for unknown directory entry types', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-unknown-dirent-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'regular.txt'), 'portable\n');
  const [sample] = await readdir(source, { withFileTypes: true });
  const direntPrototype = Object.getPrototypeOf(sample);
  const originalMethods = {
    isDirectory: direntPrototype.isDirectory,
    isFile: direntPrototype.isFile,
    isSymbolicLink: direntPrototype.isSymbolicLink,
  };
  direntPrototype.isDirectory = () => false;
  direntPrototype.isFile = () => false;
  direntPrototype.isSymbolicLink = () => false;
  try {
    const snapshot = await __testEnumerateWorkspace(source);
    assert.deepEqual(snapshot.public_records.map((record) => record.path), ['regular.txt']);
  } finally {
    Object.assign(direntPrototype, originalMethods);
  }
});

test('large local snapshots use bounded spooling and diff output has an explicit cap', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-spool-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  const payload = Buffer.alloc(2 * 1024 * 1024 + 17, 0x61);
  await writeFile(path.join(source, 'large.txt'), payload);
  const inspected = await inspectLocalWorkspace({ source_workspace: source });
  assert.equal(inspected.total_bytes, payload.byteLength);
  assert.equal(inspected.files[0].bytes, payload.byteLength);
  const snapshot = await __testEnumerateWorkspace(source, { maxBytes: payload.byteLength + 1 });
  assert.deepEqual(snapshot.public_records, inspected.files);

  const fixture = await makeFixture('risk-fork-local-diff-bound-');
  t.after(() => disposeFixture(fixture));
  const forkDirectory = fixture.adapter.forks.get(fixture.fork.fork_ref).directory;
  await writeFile(path.join(forkDirectory, 'oversized.txt'), Buffer.alloc(16 * 1024 * 1024 + 1, 0x62));
  await assert.rejects(
    fixture.adapter.collectDiff({ fork_ref: fixture.fork.fork_ref }),
    /Local reference diff content exceeds 16777216 bytes/,
  );

  const aggregateFixture = await makeFixture('risk-fork-local-diff-aggregate-');
  t.after(() => disposeFixture(aggregateFixture));
  const aggregateDirectory = aggregateFixture.adapter.forks.get(aggregateFixture.fork.fork_ref).directory;
  await writeFile(path.join(aggregateDirectory, 'first.txt'), Buffer.alloc(9 * 1024 * 1024, 0x63));
  await writeFile(path.join(aggregateDirectory, 'second.txt'), Buffer.alloc(9 * 1024 * 1024, 0x64));
  await assert.rejects(
    aggregateFixture.adapter.collectDiff({ fork_ref: aggregateFixture.fork.fork_ref }),
    /Local reference diff materialization exceeds 16777216 bytes/,
  );
});

test('local workspace rejects a nested directory symlink before traversing outside', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-directory-link-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const outside = path.join(temporary, 'outside');
  await mkdir(source);
  await mkdir(outside);
  await writeFile(path.join(outside, 'sentinel.txt'), 'must remain outside\n');
  try {
    await symlink(
      outside,
      path.join(source, 'linked-directory'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  } catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`directory link creation unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(
    inspectLocalWorkspace({ source_workspace: source }),
    /symlinks are forbidden/i,
  );
  assert.equal(await access(path.join(outside, 'sentinel.txt')).then(() => true), true);
});

test('local workspace rejects a nested directory replacement after parent enumeration', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-local-directory-swap-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const source = path.join(temporary, 'source');
  const nested = path.join(source, 'nested');
  const replacement = path.join(source, 'replacement');
  await mkdir(nested, { recursive: true });
  await mkdir(replacement, { recursive: true });
  await writeFile(path.join(nested, 'trusted.txt'), 'trusted\n');
  await writeFile(path.join(replacement, 'unexpected.txt'), 'unexpected\n');

  let swapped = false;
  await assert.rejects(
    __testEnumerateWorkspace(source, {
      afterRead: async ({ directory, prefix }) => {
        if (swapped || prefix !== '') return;
        swapped = true;
        await rename(path.join(directory, 'nested'), path.join(directory, 'nested-original'));
        await rename(path.join(directory, 'replacement'), path.join(directory, 'nested'));
      },
    }),
    /Filesystem identity changed while it was being captured: nested/,
  );
  assert.equal(swapped, true);
  assert.equal(await access(path.join(source, 'nested-original', 'trusted.txt')).then(() => true), true);
  assert.equal(await access(path.join(source, 'nested', 'unexpected.txt')).then(() => true), true);
});

function waitForExactStdoutLine(child, expectedLine, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let timer = null;

    const cleanup = () => {
      if (timer !== null) clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
    };
    const finish = (error = null) => {
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const onData = (chunk) => {
      stdout += chunk.toString('utf8');
      if (stdout.length > 1_024) {
        finish(new Error('Windows lock helper emitted excessive readiness output'));
        return;
      }
      const newlineIndex = stdout.indexOf('\n');
      if (newlineIndex === -1) return;
      const line = stdout.slice(0, newlineIndex).replace(/\r$/u, '');
      if (line !== expectedLine) {
        finish(new Error(`Windows lock helper emitted unexpected readiness line: ${JSON.stringify(line)}`));
        return;
      }
      finish();
    };
    const onError = (error) => finish(error);
    const onClose = (code, signal) => {
      finish(new Error(`Windows lock helper closed before ready (code=${code}, signal=${signal})`));
    };

    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
    timer = setTimeout(() => {
      finish(new Error(`Windows lock helper was not ready within ${timeoutMs}ms`));
    }, timeoutMs);
  });
}

async function waitForClose(closePromise, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      closePromise,
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Windows lock helper did not close within ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function startWindowsExclusiveLock(lockPath) {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (typeof systemRoot !== 'string' || !path.isAbsolute(systemRoot)) {
    throw new Error('Windows lock helper requires an absolute SystemRoot or WINDIR');
  }
  const powershell = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$lockPath = [Environment]::GetEnvironmentVariable('RISK_FORK_TEST_LOCK_PATH')",
    "if ([String]::IsNullOrWhiteSpace($lockPath)) { throw 'Missing lock path' }",
    '$stream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
    'try {',
    `  [Console]::Out.WriteLine('${WINDOWS_LOCK_READY}')`,
    '  [Console]::Out.Flush()',
    '  [Console]::In.ReadLine() | Out-Null',
    '} finally {',
    '  $stream.Dispose()',
    '}',
  ].join('\n');
  const childEnv = { RISK_FORK_TEST_LOCK_PATH: lockPath };
  for (const key of ['SystemRoot', 'WINDIR']) {
    if (typeof process.env[key] === 'string') childEnv[key] = process.env[key];
  }
  const child = spawn(powershell, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    script,
  ], {
    env: childEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let processError = null;
  child.stderr.on('data', (chunk) => {
    if (stderr.length < 4_096) stderr += chunk.toString('utf8');
  });
  child.on('error', (error) => {
    processError ??= error;
  });
  const closePromise = new Promise((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });

  try {
    await waitForExactStdoutLine(child, WINDOWS_LOCK_READY, WINDOWS_LOCK_START_TIMEOUT_MS);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await waitForClose(closePromise, WINDOWS_LOCK_CLOSE_TIMEOUT_MS).catch(() => {});
    const detail = stderr.trim();
    if (detail) error.message = `${error.message}: ${detail}`;
    throw error;
  }

  let stopped = false;
  return {
    async release() {
      if (stopped) return;
      child.stdin.end();
      let close;
      try {
        close = await waitForClose(closePromise, WINDOWS_LOCK_CLOSE_TIMEOUT_MS);
      } catch (error) {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        await waitForClose(closePromise, WINDOWS_LOCK_CLOSE_TIMEOUT_MS).catch(() => {});
        stopped = true;
        throw error;
      }
      stopped = true;
      assert.equal(processError, null, 'Windows lock helper must not emit a process error');
      assert.equal(close.signal, null, 'Windows lock helper must exit without a signal');
      assert.equal(close.code, 0, `Windows lock helper failed: ${stderr.trim()}`);
      assert.equal(stderr.trim(), '', 'Windows lock helper must not emit stderr');
    },
    async dispose() {
      if (stopped) return;
      child.stdin.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await waitForClose(closePromise, WINDOWS_LOCK_CLOSE_TIMEOUT_MS);
      stopped = true;
    },
  };
}

test('local reference admission starts exactly one runner and suspend never changes state', async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-concurrency-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    assert.equal(adapter.capabilities.supports_suspend_resume, false);
    assert.equal(adapter.capabilities.supports_verified_destruction, false);
    assert.equal(adapter.capabilities.supports_hard_ttl, false);
    assert.equal(adapter.capabilities.supports_max_execution_time, false);
    assert.equal(adapter.capabilities.adapter_implementation, 'test_only_injected_runner');
    const readyEvidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    await assert.rejects(
      adapter.suspendFork({ fork_ref: fork.fork_ref }),
      /does not support suspend\/resume; fork remains ready/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), readyEvidence);

    const winner = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: operation('winner.txt', 'winner'),
    });
    assert.equal(runnerControl.starts.length, 1);
    const executingEvidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(executingEvidence.status, 'executing');
    await assert.rejects(
      adapter.suspendFork({ fork_ref: fork.fork_ref }),
      /does not support suspend\/resume; fork remains executing/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), executingEvidence);

    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('loser.txt', 'loser'),
      }),
      /Cannot execute from fork state executing/,
    );
    assert.equal(runnerControl.starts.length, 1);

    assert.equal(runnerControl.starts[0].complete(), true);
    const result = await winner;
    assert.equal(result.status, 'completed');
    assert.equal((await adapter.getForkStatus({ fork_ref: fork.fork_ref })).status, 'tainted');

    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'tainted');
    assert.equal(evidence.last_execution.result_hash, result.result_hash);
    assertEvidenceHash(evidence);
    await assert.rejects(
      adapter.suspendFork({ fork_ref: fork.fork_ref }),
      /does not support suspend\/resume; fork remains tainted/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), evidence);

    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('replay.txt', 'replay'),
      }),
      /Cannot execute from fork state tainted/,
    );
    assert.equal(runnerControl.starts.length, 1);
  } finally {
    await disposeFixture(fixture);
  }
});

test('trusted test-runner output is canonicalized once before hashing and return', async () => {
  let rawParsed = null;
  let expectedHash = null;
  const runnerControl = {
    starts: [],
    operationRunner(input) {
      rawParsed = runnerResult({ input }).parsed;
      expectedHash = sha256Ref(rawParsed);
      return {
        result: Promise.resolve({ parsed: rawParsed, stdout_bytes: 128 }),
        async terminate() {},
      };
    },
  };
  const fixture = await makeFixture('risk-fork-local-result-clone-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    const execution = await adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: operation('immutable.txt', 'original'),
    });
    rawParsed.commit_candidate.payload.answer = 'mutated-after-resolution';
    assert.equal(execution.commit_candidate.payload.answer, 'original');
    assert.equal(execution.result_hash, expectedHash);
    assert.equal(Object.isFrozen(execution.commit_candidate), true);
    assert.equal(Object.isFrozen(execution.commit_candidate.payload), true);
  } finally {
    await disposeFixture(fixture);
  }
});

test('trusted test-runner output rejects accessors before evidence hashing', async () => {
  const runnerControl = {
    starts: [],
    operationRunner(input) {
      const parsed = runnerResult({ input }).parsed;
      const envelope = { parsed };
      Object.defineProperty(envelope, 'stdout_bytes', {
        enumerable: true,
        get() {
          parsed.commit_candidate.payload.answer = 'mutated-by-accessor';
          return 128;
        },
      });
      return {
        result: Promise.resolve(envelope),
        async terminate() {},
      };
    },
  };
  const fixture = await makeFixture('risk-fork-local-result-accessor-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('accessor.txt', 'original'),
      }),
      /hidden or accessor field/,
    );
    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.last_execution, null);
    assertEvidenceHash(evidence);
  } finally {
    await disposeFixture(fixture);
  }
});

test('explicit destruction cancels one lease, serializes callers, and prevents late mutation', async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-destroy-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    const execution = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: operation('never-committed.txt', 'never-committed'),
    });
    const entry = runnerControl.starts[0];
    const firstDestroy = adapter.destroyFork({ fork_ref: fork.fork_ref, reason: 'test' });
    const secondDestroy = adapter.destroyFork({ fork_ref: fork.fork_ref, reason: 'duplicate' });
    await entry.termination_started;
    assert.equal(entry.terminate_calls, 1);
    const destroyingEvidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(destroyingEvidence.status, 'destroying');
    assert.equal(destroyingEvidence.last_execution, null);
    assertEvidenceHash(destroyingEvidence);
    await assert.rejects(
      adapter.suspendFork({ fork_ref: fork.fork_ref }),
      /does not support suspend\/resume; fork remains destroying/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), destroyingEvidence);

    let destructionSettled = false;
    firstDestroy.then(
      () => { destructionSettled = true; },
      () => { destructionSettled = true; },
    );
    await delay(25);
    assert.equal(destructionSettled, false, 'destroy must await child closure');

    await writeFile(path.join(entry.input.workspace, 'before-close.txt'), 'child-still-open\n');
    assert.equal(entry.complete(), true, 'a late success may race destruction');
    await assert.rejects(
      execution,
      (error) => error?.code === 'LOCAL_REFERENCE_EXECUTION_CANCELLED',
    );
    const [firstResult, secondResult] = await Promise.all([firstDestroy, secondDestroy]);
    assert.deepEqual(secondResult, firstResult);
    assert.equal(entry.terminate_calls, 1);

    const destroyedEvidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(destroyedEvidence.status, 'destroyed');
    assert.equal(destroyedEvidence.last_execution, null);
    assertEvidenceHash(destroyedEvidence);
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
    await assert.rejects(access(entry.input.workspace), (error) => error?.code === 'ENOENT');
    assert.equal(entry.complete(), false, 'a closed child cannot publish a late result');
    await delay(25);
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
  } finally {
    await disposeFixture(fixture);
  }
});

test('execution admission destroys a fork at its exact wall-clock expiry without starting a runner', async () => {
  const runnerControl = createControlledRunner();
  let now = new Date(NOW);
  const fixture = await makeFixture('risk-fork-local-expiry-boundary-', {
    runnerControl,
    ttlMs: 1_000,
    clock: () => new Date(now),
  });
  const { adapter, fork } = fixture;
  try {
    now = new Date(fork.expires_at);
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('expired.txt', 'expired'),
      }),
      (error) => error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED',
    );
    assert.equal(runnerControl.starts.length, 0);
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'destroyed');
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
  } finally {
    await disposeFixture(fixture);
  }
});

test('atomic admission rejects when the wall clock advances during operation validation', async () => {
  const runnerControl = createControlledRunner();
  let now = new Date(NOW);
  const fixture = await makeFixture('risk-fork-local-expiry-validation-race-', {
    runnerControl,
    ttlMs: 1_000,
    clock: () => new Date(now),
  });
  const { adapter, fork } = fixture;
  try {
    const advancingOperation = new Proxy(operation('expired-race.txt', 'expired-race'), {
      ownKeys(target) {
        now = new Date(fork.expires_at);
        return Reflect.ownKeys(target);
      },
    });
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: advancingOperation,
      }),
      (error) => error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED',
    );
    assert.equal(runnerControl.starts.length, 0);
    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'destroyed');
    assert.equal(evidence.last_execution, null);
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
  } finally {
    await disposeFixture(fixture);
  }
});

test('event-loop starvation cannot open an execution window after the hard TTL', {
  timeout: 4_000,
}, async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-expiry-starvation-', {
    runnerControl,
    ttlMs: 1_000,
  });
  const { adapter, fork } = fixture;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('starved.txt', 'starved'),
      }),
      (error) => error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED',
    );
    assert.equal(runnerControl.starts.length, 0);
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'destroyed');
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
  } finally {
    await disposeFixture(fixture);
  }
});

test('a ready result after event-loop starvation past TTL is destroyed before rejection', {
  timeout: 4_000,
}, async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-completion-ttl-race-', {
    runnerControl,
    ttlMs: 1_000,
  });
  const { adapter, fork } = fixture;
  try {
    const execution = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      timeout_ms: 3_000,
      operation: operation('late-ttl.txt', 'late-ttl'),
    });
    const entry = runnerControl.starts[0];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_100);
    assert.equal(entry.complete(), true, 'runner result becomes ready before delayed TTL callbacks');
    await assert.rejects(
      execution,
      (error) => error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED',
    );
    assert.equal(entry.terminate_calls, 1);
    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'destroyed');
    assert.equal(evidence.last_execution, null);
    assertEvidenceHash(evidence);
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
    await assert.rejects(access(entry.input.workspace), (error) => error?.code === 'ENOENT');
  } finally {
    await disposeFixture(fixture);
  }
});

test('hard TTL cancels and closes an active runner before deleting its workspace', {
  timeout: 4_000,
}, async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-ttl-', {
    runnerControl,
    ttlMs: 1_000,
  });
  const { adapter, fork } = fixture;
  try {
    const execution = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      timeout_ms: 3_000,
      operation: operation('ttl-race.txt', 'ttl-race'),
    });
    const entry = runnerControl.starts[0];
    await Promise.race([
      entry.termination_started,
      delay(2_000).then(() => { throw new Error('hard TTL did not request termination'); }),
    ]);
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'destroying');
    assert.equal(entry.terminate_calls, 1);
    entry.close();
    await assert.rejects(
      execution,
      (error) => error?.code === 'LOCAL_REFERENCE_FORK_EXPIRED',
    );
    const evidence = await waitForStatus(adapter, fork.fork_ref, 'destroyed');
    assert.equal(evidence.last_execution, null);
    assertEvidenceHash(evidence);
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
    await assert.rejects(access(entry.input.workspace), (error) => error?.code === 'ENOENT');
  } finally {
    await disposeFixture(fixture);
  }
});

test('execution timeout waits for child closure before returning a terminal failure', async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-timeout-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    const execution = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      timeout_ms: 100,
      operation: operation('timeout.txt', 'timeout'),
    });
    const entry = runnerControl.starts[0];
    let executionSettled = false;
    execution.then(
      () => { executionSettled = true; },
      () => { executionSettled = true; },
    );
    await entry.termination_started;
    assert.equal(entry.termination_reason?.code, 'LOCAL_REFERENCE_EXECUTION_TIMEOUT');
    await delay(25);
    assert.equal(executionSettled, false, 'timeout must not return before child closure');
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'executing');

    entry.close();
    await assert.rejects(
      execution,
      (error) => error?.code === 'LOCAL_REFERENCE_EXECUTION_TIMEOUT',
    );
    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.last_execution, null);
    assertEvidenceHash(evidence);
    assert.equal(entry.terminate_calls, 1);
  } finally {
    await disposeFixture(fixture);
  }
});

test('a late completion cannot win against an absolute execution deadline', async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-timeout-race-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    const execution = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      timeout_ms: 100,
      operation: operation('late-timeout.txt', 'late-timeout'),
    });
    const entry = runnerControl.starts[0];
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 150);
    assert.equal(entry.complete(), true);
    await assert.rejects(
      execution,
      (error) => error?.code === 'LOCAL_REFERENCE_EXECUTION_TIMEOUT',
    );
    assert.equal(entry.terminate_calls, 1);
    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'failed');
    assert.equal(evidence.last_execution, null);
    assertEvidenceHash(evidence);
  } finally {
    await disposeFixture(fixture);
  }
});

test('destroy failure blocks replay but an explicit retry can finish cleanup', async () => {
  const runnerControl = createControlledRunner();
  const fixture = await makeFixture('risk-fork-local-destroy-failure-', { runnerControl });
  const { adapter, fork } = fixture;
  try {
    const execution = adapter.executeInFork({
      fork_ref: fork.fork_ref,
      execution_mode: 'isolated_execution',
      operation: operation('destroy-failure.txt', 'destroy-failure'),
    });
    const entry = runnerControl.starts[0];
    entry.failTermination(new Error('synthetic child closure verification failure'));
    const destruction = adapter.destroyFork({ fork_ref: fork.fork_ref });
    await entry.termination_started;
    assert.equal(
      entry.fail(new Error('synthetic late execution failure')),
      true,
      'a late child error may race destruction',
    );
    await assert.rejects(
      execution,
      /synthetic late execution failure/,
    );
    await assert.rejects(destruction, /synthetic child closure verification failure/);

    const evidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(evidence.status, 'destroy_failed');
    assert.equal(evidence.last_execution, null);
    assertEvidenceHash(evidence);
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('forbidden-retry.txt', 'forbidden-retry'),
      }),
      /Cannot execute from fork state destroy_failed/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), evidence);
    entry.clearTerminationFailure();
    const retry = await adapter.destroyFork({ fork_ref: fork.fork_ref });
    assert.equal(retry.status, 'destroy_requested_observed');
    assert.equal(entry.terminate_calls, 2);
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'destroyed');
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
  } finally {
    await disposeFixture(fixture);
  }
});

test('Windows retries destruction after a transient workspace lock is released', {
  skip: process.platform !== 'win32',
  timeout: 90_000,
}, async () => {
  const fixture = await makeFixture('risk-fork-local-windows-destroy-retry-');
  const { adapter, fork } = fixture;
  let lock = null;
  try {
    const workspace = adapter.forks.get(fork.fork_ref).directory;
    lock = await startWindowsExclusiveLock(path.join(workspace, '.exclusive-delete-lock'));

    await assert.rejects(
      adapter.destroyFork({ fork_ref: fork.fork_ref }),
      (error) => ['EBUSY', 'EPERM'].includes(error?.code),
    );
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'destroy_failed');
    await access(workspace);

    await lock.release();
    lock = null;

    const retry = await adapter.destroyFork({ fork_ref: fork.fork_ref });
    assert.equal(retry.status, 'destroy_requested_observed');
    assert.equal((await adapter.collectEvidence({ fork_ref: fork.fork_ref })).status, 'destroyed');
    assert.equal((await adapter.verifyDestroyed({ fork_ref: fork.fork_ref })).status, 'verified');
    await assert.rejects(access(workspace), (error) => error?.code === 'ENOENT');
  } finally {
    try {
      if (lock) await lock.dispose();
    } finally {
      await disposeFixture(fixture);
    }
  }
});

test('failed and destroyed production-runner forks reject replay without changing evidence', async () => {
  const fixture = await makeFixture('risk-fork-local-terminal-');
  const { adapter, fork } = fixture;
  try {
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: {
          kind: 'bounded_file_batch',
          actions: [{ type: 'read', path: 'missing.txt' }],
        },
      }),
      /Local reference operation failed/,
    );
    const failedEvidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(failedEvidence.status, 'failed');
    assert.equal(failedEvidence.last_execution, null);
    assertEvidenceHash(failedEvidence);
    await assert.rejects(
      adapter.suspendFork({ fork_ref: fork.fork_ref }),
      /does not support suspend\/resume; fork remains failed/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), failedEvidence);

    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: operation('retry.txt', 'retry'),
      }),
      /Cannot execute from fork state failed/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), failedEvidence);
    assert.deepEqual((await adapter.collectDiff({ fork_ref: fork.fork_ref })).files, []);

    await adapter.destroyFork({ fork_ref: fork.fork_ref });
    const destroyedEvidence = await adapter.collectEvidence({ fork_ref: fork.fork_ref });
    assert.equal(destroyedEvidence.status, 'destroyed');
    assert.equal(destroyedEvidence.last_execution, null);
    assertEvidenceHash(destroyedEvidence);
    await assert.rejects(
      adapter.suspendFork({ fork_ref: fork.fork_ref }),
      /does not support suspend\/resume; fork remains destroyed/,
    );
    assert.deepEqual(await adapter.collectEvidence({ fork_ref: fork.fork_ref }), destroyedEvidence);
  } finally {
    await disposeFixture(fixture);
  }
});
