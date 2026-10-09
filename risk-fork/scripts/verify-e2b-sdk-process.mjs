// Explicit provider-free Linux conformance, separate from live qualification.
// --prepare writes only synthetic SDK fixtures before their read-only mount.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  createE2BRuntimeSdkIntegrityVerifier,
  loadVerifiedE2BRuntimeSdk,
} from '../src/e2b-qualification.mjs';
import {
  createE2BRuntimeSdkProcessBoundary,
  isE2BRuntimeSdkProcessPreEntryFailure,
  isE2BRuntimeSdkProcessSandboxClass,
} from '../src/e2b-sdk-process.mjs';
import { sha256Ref } from '../src/canonical.mjs';
import { createForkIdentity, createSavepointCapsule } from '../src/contracts.mjs';
import { E2BRiskForkAdapter } from '../src/adapters/e2b.mjs';
import { inspectLocalWorkspace } from '../src/adapters/local-reference.mjs';

const [mode, directory, artifact] = process.argv.slice(2);
if (!['--prepare', '--verify'].includes(mode) || !path.isAbsolute(directory ?? '')
  || mode === '--verify' && !path.isAbsolute(artifact ?? '') || process.argv.length !== (mode === '--verify' ? 5 : 4)) {
  throw new Error('Use --prepare ABSOLUTE_FIXTURE_DIRECTORY or --verify ABSOLUTE_FIXTURE_DIRECTORY ABSOLUTE_RUNTIME_BUNDLE');
}

function syntheticSdk() {
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  const revision = require('synthetic-sdk-dependency').revision;
  const log = (value) => fs.appendFileSync('/tmp/risk-fork-sdk-process-effects', `${value}\n`);
  const children = new Map();
  const commandGates = new Map();
  const orphanFile = '/tmp/risk-fork-sdk-process-synthetic-orphan.json';
  const orphan = () => fs.existsSync(orphanFile) ? JSON.parse(fs.readFileSync(orphanFile, 'utf8')) : null;
  class SandboxNotFoundError extends Error {}
  class FileNotFoundError extends Error {}
  class Sandbox {
    static async create(template, options) {
      log('create');
      if (template === 'throw') throw new Error('synthetic private error must not cross IPC');
      if (template === 'hang') return new Promise(() => {});
      const value = new Sandbox(template);
      if (template === 'throw-after-effect') {
        fs.writeFileSync(orphanFile, JSON.stringify({ sandboxId: value.sandboxId, templateId: template, metadata: options.metadata }));
        throw new Error('synthetic allocation response lost after effect');
      }
      children.set(value.sandboxId, value); return value;
    }
    static async getInfo(id) {
      const value = children.get(id);
      if (!value) { const stored = orphan(); if (stored?.sandboxId === id) return stored; throw new SandboxNotFoundError(); }
      return { sandboxId: id, templateId: value.template, metadata: {
        pid: String(process.pid), revision, execArgv: JSON.stringify(process.execArgv),
        envKeys: JSON.stringify(Object.keys(process.env)), poisoned: String(globalThis.syntheticSdkPoison === true),
      } };
    }
    static list(options) {
      const items = [...children.values()].map((value) => ({ sandboxId: value.sandboxId, templateId: value.template }));
      const stored = orphan(); if (stored) items.push(stored);
      let pending = true;
      return { get hasNext() { return pending; }, async nextItems() { pending = options.query?.metadata?.cursor === 'abandon'; return items; } };
    }
    static async kill(id) { log('kill'); children.delete(id); commandGates.get(id)?.(); if (orphan()?.sandboxId === id) fs.unlinkSync(orphanFile); return true; }
    constructor(template) {
      this.sandboxId = crypto.randomUUID(); this.template = template;
      const files = new Map();
      this.files = {
        async write(target, bytes) { log('write'); files.set(target, Buffer.from(bytes)); if (target === '/throw') throw new Error('after write'); },
        async remove(target) { log('remove'); if (!files.delete(target)) throw new FileNotFoundError(); },
        async read(target, options) {
          if (target === '/hang') return new ReadableStream({ pull() { return new Promise(() => {}); }, cancel() { log('read_cancel'); } });
          if (target === '/delayed-open') return new Promise((resolve) => setTimeout(() => resolve(new ReadableStream({
            pull(controller) { controller.enqueue(Buffer.from('must-not-be-readable-after-kill')); },
            cancel() { log('delayed_read_cancel'); },
          })), 100));
          if (target === '/truncated') {
            let delivered = false;
            return new ReadableStream({ pull(controller) {
              if (!delivered) { delivered = true; controller.enqueue(Buffer.from('{"synthetic":true}')); }
              else return new Promise(() => {});
            }, cancel() { log('read_cancel'); } });
          }
          if (!files.has(target)) throw new FileNotFoundError();
          const bytes = files.get(target); let sent = false;
          return new ReadableStream({ pull(controller) { if (!sent) { sent = true; controller.enqueue(bytes); } else controller.close(); } });
        },
      };
      const sandboxId = this.sandboxId;
      this.commands = { async run(command) {
        log('command');
        if (command === 'hang') return new Promise(() => {});
        if (command === 'finish-on-kill') return new Promise((resolve) => commandGates.set(sandboxId, () => resolve({ exitCode: 0, stdout: 'late success', stderr: '' })));
        if (command === 'detached-descendant') {
          const spawned = require('node:child_process').spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
          spawned.unref(); return { exitCode: 0, stdout: String(spawned.pid), stderr: '' };
        }
        if (command === 'exit') process.exit(31);
        if (command === 'throw') throw new Error('after command');
        if (command === 'error') return { exitCode: 0, stdout: '', stderr: '', error: 'private SDK error' };
        if (command === 'oversize') return { exitCode: 0, stdout: 'x'.repeat(129 * 1024), stderr: '' };
        return { exitCode: 0, stdout: revision, stderr: '' };
      } };
      this.setTimeout = async () => { log('set_timeout'); };
      this.kill = async () => Sandbox.kill(this.sandboxId);
    }
  }
  module.exports = { Sandbox, SandboxNotFoundError, FileNotFoundError };
}

if (mode === '--prepare') {
  for (const fixture of ['main', 'unreadable', 'writable-dependency']) {
    const modules = path.join(directory, fixture, 'node_modules');
    const sdk = path.join(modules, 'e2b');
    const dependency = path.join(modules, 'synthetic-sdk-dependency');
    await mkdir(path.join(sdk, 'dist'), { recursive: true });
    await mkdir(dependency, { recursive: true });
    await writeFile(path.join(sdk, 'package.json'), JSON.stringify({ name: 'e2b', version: '2.39.0', main: 'dist/index.js', dependencies: { 'synthetic-sdk-dependency': '1.0.0' } }));
    await writeFile(path.join(sdk, 'dist/index.js'), `(${syntheticSdk.toString()})();\n`);
    await writeFile(path.join(dependency, 'package.json'), JSON.stringify({ name: 'synthetic-sdk-dependency', version: '1.0.0', main: 'index.js' }));
    await writeFile(path.join(dependency, 'index.js'), 'module.exports = { revision: "fresh" };\n');
  }
  console.log('SYNTHETIC_SDK_FIXTURES_PREPARED provider_calls=0');
} else {
  const sha = async (file) => `sha256:${createHash('sha256').update(await readFile(file)).digest('hex')}`;
  const options = { runtimeArtifactPath: artifact, runtimeArtifactHash: await sha(artifact),
    nodeArtifactHash: await sha(process.execPath), packageDirectory: path.join(directory, 'main/node_modules/e2b'), deadlineMs: 2_000, lifetimeMs: 10_000 };
  const effects = async () => (await readFile('/tmp/risk-fork-sdk-process-effects', 'utf8').catch(() => '')).split('\n').filter(Boolean);
  const opened = async (t, extra = {}) => {
    const boundary = createE2BRuntimeSdkProcessBoundary({ ...options, ...extra });
    t.after(async () => { assert.equal((await boundary.close()).sdk_process_terminated, true); });
    const verifier = createE2BRuntimeSdkIntegrityVerifier({ processBoundary: boundary });
    const binding = await verifier.inspect();
    const { module } = await loadVerifiedE2BRuntimeSdk(binding, verifier);
    return { boundary, Sandbox: module.Sandbox, binding };
  };
  let workspaceInspectionTail = Promise.resolve();
  const inspectInStateHome = async (stateHome, source, maxBytes = 32 * 1024 * 1024) => {
    let release;
    const predecessor = workspaceInspectionTail;
    workspaceInspectionTail = new Promise((resolve) => { release = resolve; });
    await predecessor;
    try {
      process.env.XDG_STATE_HOME = stateHome;
      await mkdir(path.join(stateHome, 'agoragentic-risk-fork', 'standalone'), { recursive: true, mode: 0o700 });
      return await inspectLocalWorkspace({ source_workspace: source, max_bytes: maxBytes });
    } finally {
      release();
    }
  };
  const adapterFixture = async (t, Sandbox, { fileBytes = [['input.txt', Buffer.from('synthetic bounded input\\n')],], maxBytes = 64 * 1024 * 1024 } = {}) => {
    const root = await mkdtemp('/tmp/risk-fork-sdk-process-adapter-');
    const stateHome = '/tmp/risk-fork-sdk-process-shared-state';
    process.env.XDG_STATE_HOME = stateHome;
    await mkdir(path.join(stateHome, 'agoragentic-risk-fork', 'standalone'), { recursive: true, mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'); await mkdir(source);
    for (const [name, bytes] of fileBytes) {
      const target = path.join(source, name); await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, bytes);
    }
    const { workspace_digest: digest } = await inspectInStateHome(stateHome, source, maxBytes);
    const hash = sha256Ref; const now = new Date();
    const capsule = createSavepointCapsule({
      created_at: now, expires_at: new Date(now.getTime() + 60_000),
      parent: { agent_id: 'synthetic-parent', session_id: 'synthetic-session', state_hash: hash('parent'), lineage_ref: 'lineage:synthetic', lineage_hash: hash('lineage') },
      agent_configuration: { model_version_hash: hash('model'), system_instruction_hash: hash('system'), tool_manifest_hash: hash('tools') },
      checkpoint: { goal_ref: 'goal:synthetic', goal_hash: hash('goal'), task_graph_ref: 'graph:synthetic', task_graph_hash: hash('graph') },
      memory_roots: [], workspace: { snapshot_ref: 'workspace:synthetic', digest },
      governance: { policy_ref: 'policy:synthetic', policy_version: '1', policy_hash: hash('policy'), mandate_ref: 'mandate:synthetic', mandate_version: '1', mandate_hash: hash('mandate'), budget_policy_ref: 'budget:synthetic', budget_version: '1', budget_hash: hash('budget'), epoch: 'epoch:synthetic' },
      receipt_chain_head: hash('receipts'), proposed_interaction: { mcp_server_ref: 'mcp:synthetic', mcp_server_origin: 'https://synthetic.invalid/', mcp_method: 'tools/call', tool_name: 'synthetic_tool', effective_arguments_hash: hash({}), target_ref: 'target:synthetic' },
      execution_authorization: { ref: 'authorization:synthetic', hash: hash('authorization') },
      allowed_commit_types: ['TYPED_RESULT'], authorized_result_schema_hash: hash({ type: 'object', additionalProperties: false }), runtime_snapshot: { mode: 'none' },
    });
    const bootstrap = hash('synthetic-bootstrap'), runner = hash('synthetic-runner');
    const adapter = new E2BRiskForkAdapter({ SandboxClass: Sandbox, offlineConformance: true, maxBytes,
      cleanTemplateId: 'normal', cleanTemplateHash: hash('template'), cleanTemplateProvenanceHash: hash('provenance'),
      workspaceExportDirectory: path.join(root, 'exports'), cleanupJournalDirectory: path.join(root, 'journal'),
      trustedBootstrapArtifactHash: bootstrap, trustedRunnerArtifactHash: runner,
      verifyAuthorityFreeSource: async (request) => ({
        schema: 'agoragentic.risk-fork.authority-free-source-attestation.v1', status: 'verified', request_hash: request.request_hash,
        evidence_ref: 'attestation:synthetic', evidence_hash: hash('synthetic'), workspace_digest: request.workspace_digest,
        workspace_manifest_hash: request.workspace_manifest_hash, trusted_bootstrap_artifact_hash: bootstrap, trusted_runner_artifact_hash: runner,
        claims: Object.fromEntries(['authority_free', 'credentials_absent', 'wallet_material_absent', 'execution_authority_absent', 'workspace_manifest_verified', 'immutable_export_verified', 'trusted_runtime_artifacts_verified'].map((key) => [key, true])),
      }),
    });
    const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
    const request = { savepoint_ref: savepoint.savepoint_ref,
      fork_identity: createForkIdentity({ parent_agent_id: capsule.parent.agent_id, parent_session_id: capsule.parent.session_id, issued_at: now }),
      network_policy: { mode: 'blocked', allowlist: [] }, ttl_ms: 30_000 };
    return { root, source, adapter, request };
  };
  test('fresh SDK worker ignores parent CJS/ESM preloads and ambient environment', async (t) => {
    globalThis.syntheticSdkPoison = true;
    process.env.SYNTHETIC_PROVIDER_KEY_SENTINEL = 'not-a-real-key';
    process.env.NODE_OPTIONS = '--import=/not-forwarded.mjs';
    const entry = path.join(options.packageDirectory, 'dist/index.js');
    const require = createRequire(import.meta.url);
    require(entry).Sandbox.create = () => { throw new Error('poisoned parent module'); };
    await import(pathToFileURL(entry).href);
    const { Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const info = await Sandbox.getInfo(child.sandboxId);
    assert.notEqual(Number(info.metadata.pid), process.pid);
    assert.equal(info.metadata.revision, 'fresh');
    assert.equal(info.metadata.poisoned, 'false');
    assert.deepEqual(JSON.parse(info.metadata.envKeys), []);
    const flags = JSON.parse(info.metadata.execArgv);
    assert.equal(flags.some((value) => value.startsWith('--import') || value.startsWith('--require') || value.startsWith('--loader')), false);
    assert.equal(await child.kill(), true);
  });
  test('chunked binary transport, streaming and real typed absence mappings', async (t) => {
    const { Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const data = Buffer.alloc(192 * 1024 + 11, 159);
    await child.files.write('/data', data);
    const chunks = []; const reader = (await child.files.read('/data', { format: 'stream' })).getReader();
    for (;;) { const next = await reader.read(); if (next.done) break; assert.ok(next.value.length <= 64 * 1024); chunks.push(next.value); }
    assert.deepEqual(Buffer.concat(chunks), data);
    await child.files.remove('/data');
    await assert.rejects(child.files.read('/data', { format: 'stream' }), { name: 'FileNotFoundError' });
    const command = await child.commands.run('normal', { timeoutMs: 1_000 });
    assert.equal(command.stdout, 'fresh');
    await child.setTimeout(1_000);
    assert.equal(await child.kill(), true);
    await assert.rejects(Sandbox.getInfo(child.sandboxId), { name: 'SandboxNotFoundError' });
  });
  test('actual worker capacity rejects the 33rd create before SDK entry and recovers after release', async (t) => {
    const { boundary, Sandbox } = await opened(t, { lifetimeMs: 30_000 });
    const children = [];
    try {
      for (let count = 0; count < 32; count += 1) {
        children.push(await Sandbox.create('normal', {}));
      }
      const before = boundary.metrics();
      let preEntryError;
      await assert.rejects(Sandbox.create('normal', {}), (error) => {
        preEntryError = error;
        return error.code === 'E2B_SDK_PROCESS_NOT_ENTERED';
      });
      assert.equal(isE2BRuntimeSdkProcessSandboxClass(Sandbox), true);
      assert.equal(isE2BRuntimeSdkProcessPreEntryFailure(preEntryError, Sandbox), true);
      assert.equal(isE2BRuntimeSdkProcessPreEntryFailure(new Error(preEntryError.message), Sandbox), false);
      assert.equal(isE2BRuntimeSdkProcessPreEntryFailure(preEntryError, new Proxy(Sandbox, {})), false);
      const secondScope = await opened(t);
      assert.equal(isE2BRuntimeSdkProcessSandboxClass(secondScope.Sandbox), true);
      assert.equal(isE2BRuntimeSdkProcessPreEntryFailure(preEntryError, secondScope.Sandbox), false);
      const rejected = boundary.metrics();
      assert.equal(
        rejected.requests_rejected_before_sdk,
        before.requests_rejected_before_sdk + 1,
      );
      assert.equal(
        rejected.effectful_outcomes_unknown,
        before.effectful_outcomes_unknown,
        'pre-entry capacity rejection is not an ambiguous provider effect',
      );
      assert.equal(await children.shift().kill(), true);
      const recovered = await Sandbox.create('normal', {});
      assert.ok(recovered.sandboxId, 'a later allocation is possible after release');
      children.push(recovered);
    } finally {
      for (const child of children) await child.kill().catch(() => {});
    }
  });
  test('adapter preserves a reusable savepoint across authenticated pre-entry capacity rejection', async (t) => {
    const { boundary, Sandbox } = await opened(t, { lifetimeMs: 30_000 });
    const fixture = await adapterFixture(t, Sandbox);
    const held = [];
    try {
      for (let count = 0; count < 32; count += 1) held.push(await Sandbox.create('normal', {}));
      const effectsBefore = (await effects()).filter((value) => value === 'create').length;
      const metricsBefore = boundary.metrics();
      let releaseCleanup; let cleanupStarted;
      const cleanupStartedPromise = new Promise((resolve) => { cleanupStarted = resolve; });
      const cleanupGate = new Promise((resolve) => { releaseCleanup = resolve; });
      const originalMarkAbsent = fixture.adapter.cleanupJournal.markSandboxVerifiedAbsent.bind(fixture.adapter.cleanupJournal);
      fixture.adapter.cleanupJournal.markSandboxVerifiedAbsent = async (...args) => {
        cleanupStarted(); await cleanupGate; return originalMarkAbsent(...args);
      };
      const firstAttempt = fixture.adapter.createFork(fixture.request);
      await cleanupStartedPromise;
      await assert.rejects(fixture.adapter.createFork(fixture.request), /one-use|poison|already attempted/);
      releaseCleanup();
      await assert.rejects(firstAttempt, { code: 'E2B_SDK_PROCESS_NOT_ENTERED' });
      fixture.adapter.cleanupJournal.markSandboxVerifiedAbsent = originalMarkAbsent;
      const metricsAfter = boundary.metrics();
      assert.equal(metricsAfter.requests_rejected_before_sdk, metricsBefore.requests_rejected_before_sdk + 1);
      assert.equal(metricsAfter.effectful_outcomes_unknown, metricsBefore.effectful_outcomes_unknown);
      assert.equal((await effects()).filter((value) => value === 'create').length, effectsBefore, 'pre-entry rejection never entered provider create');
      await assert.rejects(fixture.adapter.createFork(fixture.request), { code: 'E2B_SDK_PROCESS_NOT_ENTERED' });
      assert.equal((await effects()).filter((value) => value === 'create').length, effectsBefore);
      assert.equal(await held.shift().kill(), true);
      await assert.rejects(fixture.adapter.createFork(fixture.request), (error) => {
        assert.doesNotMatch(String(error), /one-use|poison|already attempted/);
        return true;
      });
      assert.equal((await effects()).filter((value) => value === 'create').length, effectsBefore + 1, 'retry reached provider create after release');
    } finally {
      for (const child of held) await child.kill().catch(() => {});
      await fixture.adapter.destroySavepoint({ savepoint_ref: fixture.request.savepoint_ref }).catch(() => {});
      await boundary.close();
    }
  });
  test('authenticated process class rejects an oversized individual file before allocation while allowing a bounded aggregate', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    // The immutable export's canonical JSON envelope intentionally has a much
    // smaller serialization ceiling than the 64 MiB workspace budget. Keep
    // the filesystem fixture compact, then use the adapter's owned record to
    // represent the already-recorded 40 MiB file sizes that the process guard
    // must reject before provider create.
    const large = await adapterFixture(t, Sandbox, { maxBytes: 64 * 1024 * 1024 });
    const largeRecord = large.adapter.savepoints.get(large.request.savepoint_ref);
    largeRecord.export_record = { ...largeRecord.export_record, files: [{ ...largeRecord.export_record.files[0], bytes: 40 * 1024 * 1024 }] };
    const effectsBefore = (await effects()).filter((value) => value === 'create').length;
    await assert.rejects(large.adapter.createFork(large.request), /each file must be at most 33554432 bytes/);
    assert.equal((await effects()).filter((value) => value === 'create').length, effectsBefore, 'file-size preflight precedes provider allocation');
    await assert.rejects(large.adapter.createFork(large.request), /each file must be at most 33554432 bytes/);
    await large.adapter.destroySavepoint({ savepoint_ref: large.request.savepoint_ref });
    await rm(large.root, { recursive: true, force: true });
    const small = await adapterFixture(t, Sandbox, { maxBytes: 64 * 1024 * 1024 });
    const smallRecord = small.adapter.savepoints.get(small.request.savepoint_ref);
    const smallFile = { ...smallRecord.export_record.files[0], bytes: 20 * 1024 * 1024 };
    smallRecord.export_record = { ...smallRecord.export_record, files: [smallFile, { ...smallFile, path: 'second.bin', bytes: 20 * 1024 * 1024 }] };
    assert.ok(small.request.savepoint_ref, 'multiple small files within the aggregate budget remain admissible');
    const smallEffectsBefore = (await effects()).filter((value) => value === 'create').length;
    await assert.rejects(small.adapter.createFork(small.request), (error) => {
      assert.doesNotMatch(String(error), /each file must be at most 33554432 bytes/);
      return true;
    });
    assert.equal((await effects()).filter((value) => value === 'create').length, smallEffectsBefore + 1, 'bounded aggregate reached provider create');
    await small.adapter.destroySavepoint({ savepoint_ref: small.request.savepoint_ref });
    await boundary.close();
  });
  test('a real 40 MiB source fails at the existing canonical export ceiling before provider allocation', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const before = (await effects()).filter((value) => value === 'create').length;
    await assert.rejects(
      adapterFixture(t, Sandbox, { fileBytes: [['large.bin', Buffer.alloc(40 * 1024 * 1024, 7)]], maxBytes: 64 * 1024 * 1024 }),
      /Canonical JSON string is too large/,
    );
    assert.equal((await effects()).filter((value) => value === 'create').length, before);
    await boundary.close();
  });
  test('four 10 MiB files fit the 64 MiB aggregate and reach provider create', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const fixture = await adapterFixture(t, Sandbox, {
      fileBytes: Array.from({ length: 4 }, (_, index) => [`part-${index}.bin`, Buffer.alloc(10 * 1024 * 1024, index + 1)]),
      maxBytes: 64 * 1024 * 1024,
    });
    const before = (await effects()).filter((value) => value === 'create').length;
    await assert.rejects(fixture.adapter.createFork(fixture.request), (error) => {
      assert.doesNotMatch(String(error), /each file must be at most 33554432 bytes/);
      return true;
    });
    assert.equal((await effects()).filter((value) => value === 'create').length, before + 1);
    await fixture.adapter.destroySavepoint({ savepoint_ref: fixture.request.savepoint_ref }).catch(() => {});
    await boundary.close();
  });
  for (const command of ['throw', 'error', 'oversize', 'exit', 'hang']) {
    test(`effectful command ${command} retires its process, retains unknown outcome and never replays`, async (t) => {
      const { boundary, Sandbox } = await opened(t, { deadlineMs: 500 });
      const child = await Sandbox.create('normal', {});
      const before = (await effects()).filter((value) => value === 'command').length;
      await assert.rejects(child.commands.run(command, { timeoutMs: 500 }), /outcome is not established/);
      await assert.rejects(child.commands.run('normal', { timeoutMs: 500 }));
      assert.equal((await effects()).filter((value) => value === 'command').length, before + 1);
      assert.equal(boundary.metrics().effectful_outcomes_unknown, 1);
      assert.equal(boundary.metrics().sdk_process_retired, true);
      assert.equal((await boundary.close()).provider_cleanup_verified, false);
    });
  }
  test('allocation failure is not absence and no second allocation is admitted', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    await assert.rejects(Sandbox.create('throw', {}));
    await assert.rejects(Sandbox.create('normal', {}));
    assert.equal(boundary.metrics().effectful_outcomes_unknown, 1);
  });
  test('failure after file-write effect cannot release a usable SDK capability', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    await assert.rejects(child.files.write('/throw', 'synthetic text'));
    await assert.rejects(child.files.write('/again', 'synthetic text'));
    assert.equal(boundary.metrics().effectful_outcomes_unknown, 1);
  });
  test('abort cancels an already-pending read and releases its bounded cursor', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const controller = new AbortController();
    const reader = (await child.files.read('/hang', { format: 'stream', signal: controller.signal })).getReader();
    const pending = reader.read();
    await new Promise((resolve) => setImmediate(resolve));
    await Sandbox.getInfo(child.sandboxId);
    controller.abort(); await assert.rejects(pending);
    for (let count = 0; count < 10; count += 1) {
      const stream = await child.files.read('/hang', { format: 'stream' }); await stream.cancel();
    }
    assert.equal(boundary.metrics().sdk_process_retired, false);
    assert.ok((await effects()).includes('read_cancel'));
  });
  test('kill during delayed read opening cancels the late stream before cursor registration', async (t) => {
    const { Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const opening = child.files.read('/delayed-open', { format: 'stream' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(await child.kill(), true);
    await assert.rejects(opening);
    await assert.rejects(child.files.read('/delayed-open', { format: 'stream' }));
    assert.ok((await effects()).includes('delayed_read_cancel'));
  });
  test('provider timeout accepts fifteen minutes, rejects above the twenty-four-hour bound before SDK dispatch', async (t) => {
    const { Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    await child.setTimeout(15 * 60 * 1_000);
    const before = await effects();
    await assert.rejects(child.setTimeout(24 * 60 * 60 * 1_000 + 1));
    assert.deepEqual(await effects(), before);
  });
  test('SDK worker opens with a lifetime above the former ten-minute cap without waiting for expiry', async (t) => {
    const { boundary } = await opened(t, { lifetimeMs: 10 * 60 * 1_000 + 1 });
    assert.equal(boundary.metrics().process_starts, 1);
  });
  test('concurrent mutations reject before SDK; emergency kill can interrupt a hung command', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const command = child.commands.run('hang', { timeoutMs: 1_000 });
    const observed = assert.rejects(command);
    await assert.rejects(child.setTimeout(2_000), { code: 'E2B_SDK_PROCESS_NOT_ENTERED' });
    assert.equal(await child.kill(), true);
    await observed;
    assert.equal(boundary.metrics().requests_rejected_before_sdk, 1);
    assert.equal(boundary.metrics().effectful_outcomes_unknown, 1);
  });
  test('paginator close and killed capability retirement permit bounded repeated use', async (t) => {
    const { Sandbox } = await opened(t, { lifetimeMs: 30_000 });
    for (let count = 0; count < 36; count += 1) {
      const child = await Sandbox.create('normal', {});
      const paginator = Sandbox.list({ query: { state: ['running'], metadata: { cursor: 'abandon' } } });
      assert.equal((await paginator.nextItems()).length, 1); await paginator.close();
      assert.equal(await child.kill(), true);
      await assert.rejects(child.setTimeout(1_000), { code: 'E2B_SDK_PROCESS_NOT_ENTERED' });
    }
  });
  test('late command success after kill intent remains rejected and unknown', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const command = child.commands.run('finish-on-kill', { timeoutMs: 1_000 });
    const rejected = assert.rejects(command);
    await new Promise((resolve) => setImmediate(resolve));
    await Sandbox.getInfo(child.sandboxId);
    // Failure of the kill RPC itself may be reported unknown when retirement
    // of the overlapping command wins the race; neither is absence evidence.
    await child.kill().catch(() => {});
    await rejected;
    assert.equal(boundary.metrics().sdk_process_retired, true);
    assert.ok(boundary.metrics().effectful_outcomes_unknown >= 1);
  });
  test('retirement cannot turn a truncated read into successful EOF', async (t) => {
    const { Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const reader = (await child.files.read('/truncated', { format: 'stream' })).getReader();
    assert.equal(Buffer.from((await reader.read()).value).toString(), '{"synthetic":true}');
    const pending = reader.read(); const rejected = assert.rejects(pending, { code: 'E2B_SDK_PROCESS_READ_RETIRED' });
    await new Promise((resolve) => setImmediate(resolve)); await Sandbox.getInfo(child.sandboxId);
    assert.equal(await child.kill(), true); await rejected;
  });
  test('direct SDK exit never claims whole-tree cleanup for a detached descendant', async (t) => {
    const { boundary, Sandbox } = await opened(t);
    const child = await Sandbox.create('normal', {});
    const result = await child.commands.run('detached-descendant', { timeoutMs: 1_000 });
    const descendant = Number(result.stdout);
    assert.ok(Number.isSafeInteger(descendant) && descendant > 1);
    const cleanup = await boundary.close();
    assert.equal(cleanup.sdk_process_terminated, true);
    assert.equal(cleanup.sdk_process_tree_cleanup_verified, false);
    // Synthetic child in this disposable no-network/keyless container only.
    // Full container teardown remains the host-owned whole-tree fence.
    process.kill(descendant, 0); process.kill(descendant, 'SIGKILL');
  });
  for (const pin of ['runtimeArtifactHash', 'nodeArtifactHash']) {
    test(`${pin} mismatch fails before SDK load`, async () => {
      const boundary = createE2BRuntimeSdkProcessBoundary({ ...options, [pin]: `sha256:${'a'.repeat(64)}` });
      await assert.rejects(boundary.inspect(), { code: 'E2B_SDK_PROCESS_PROFILE_UNVERIFIED' });
      assert.equal(boundary.metrics().process_starts, 0); await boundary.close();
    });
  }
  test('read-only SDK root does not admit a writable transitive dependency mount', async () => {
    const boundary = createE2BRuntimeSdkProcessBoundary({ ...options, packageDirectory: path.join(directory, 'writable-dependency/node_modules/e2b') });
    await assert.rejects(boundary.inspect());
    assert.equal((await boundary.close()).sdk_process_terminated, true);
  });
  test('read-only mount actually rejects writes to runtime and complete SDK closure', async () => {
    for (const target of [artifact, path.join(options.packageDirectory, 'dist/index.js'),
      path.join(directory, 'main/node_modules/synthetic-sdk-dependency/index.js')]) {
      await assert.rejects(writeFile(target, 'tamper'), (error) => ['EROFS', 'EACCES'].includes(error.code));
    }
  });
  test('actual adapter journals lost allocation and needs fresh recovery plus independent absence', async (t) => {
    const root = await mkdtemp('/tmp/risk-fork-sdk-process-journal-');
    const stateHome = '/tmp/risk-fork-sdk-process-shared-state';
    process.env.XDG_STATE_HOME = stateHome;
    await mkdir(path.join(stateHome, 'agoragentic-risk-fork', 'standalone'), { recursive: true, mode: 0o700 });
    t.after(() => rm(root, { recursive: true, force: true }));
    const source = path.join(root, 'source'); await mkdir(source);
    await writeFile(path.join(source, 'input.txt'), 'synthetic bounded input\n');
    const { workspace_digest: digest } = await inspectInStateHome(stateHome, source);
    const hash = sha256Ref; const now = new Date();
    const capsule = createSavepointCapsule({
      created_at: now, expires_at: new Date(now.getTime() + 60_000),
      parent: { agent_id: 'synthetic-parent', session_id: 'synthetic-session', state_hash: hash('parent'), lineage_ref: 'lineage:synthetic', lineage_hash: hash('lineage') },
      agent_configuration: { model_version_hash: hash('model'), system_instruction_hash: hash('system'), tool_manifest_hash: hash('tools') },
      checkpoint: { goal_ref: 'goal:synthetic', goal_hash: hash('goal'), task_graph_ref: 'graph:synthetic', task_graph_hash: hash('graph') },
      memory_roots: [], workspace: { snapshot_ref: 'workspace:synthetic', digest },
      governance: { policy_ref: 'policy:synthetic', policy_version: '1', policy_hash: hash('policy'), mandate_ref: 'mandate:synthetic', mandate_version: '1', mandate_hash: hash('mandate'), budget_policy_ref: 'budget:synthetic', budget_version: '1', budget_hash: hash('budget'), epoch: 'epoch:synthetic' },
      receipt_chain_head: hash('receipts'), proposed_interaction: { mcp_server_ref: 'mcp:synthetic', mcp_server_origin: 'https://synthetic.invalid/', mcp_method: 'tools/call', tool_name: 'synthetic_tool', effective_arguments_hash: hash({}), target_ref: 'target:synthetic' },
      execution_authorization: { ref: 'authorization:synthetic', hash: hash('authorization') },
      allowed_commit_types: ['TYPED_RESULT'], authorized_result_schema_hash: hash({ type: 'object', additionalProperties: false }), runtime_snapshot: { mode: 'none' },
    });
    const bootstrap = hash('synthetic-bootstrap'), runner = hash('synthetic-runner');
    const adapterOptions = (Sandbox) => ({ SandboxClass: Sandbox, offlineConformance: true,
      cleanTemplateId: 'throw-after-effect', cleanTemplateHash: hash('template'), cleanTemplateProvenanceHash: hash('provenance'),
      workspaceExportDirectory: path.join(root, 'exports'), cleanupJournalDirectory: path.join(root, 'journal'),
      trustedBootstrapArtifactHash: bootstrap, trustedRunnerArtifactHash: runner,
      verifyAuthorityFreeSource: async (request) => ({
        schema: 'agoragentic.risk-fork.authority-free-source-attestation.v1', status: 'verified',
        request_hash: request.request_hash, evidence_ref: 'attestation:synthetic', evidence_hash: hash('synthetic'),
        workspace_digest: request.workspace_digest, workspace_manifest_hash: request.workspace_manifest_hash,
        trusted_bootstrap_artifact_hash: bootstrap, trusted_runner_artifact_hash: runner,
        claims: Object.fromEntries(['authority_free', 'credentials_absent', 'wallet_material_absent', 'execution_authority_absent', 'workspace_manifest_verified', 'immutable_export_verified', 'trusted_runtime_artifacts_verified'].map((key) => [key, true])),
      }),
    });
    const first = await opened(t);
    const adapter = new E2BRiskForkAdapter(adapterOptions(first.Sandbox));
    const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
    const request = { savepoint_ref: savepoint.savepoint_ref,
      fork_identity: createForkIdentity({ parent_agent_id: capsule.parent.agent_id, parent_session_id: capsule.parent.session_id, issued_at: now }),
      network_policy: { mode: 'blocked', allowlist: [] }, ttl_ms: 30_000 };
    await assert.rejects(adapter.createFork(request));
    await assert.rejects(adapter.createFork(request), /one-use|poison|already attempted/);
    assert.equal((await first.boundary.close()).provider_cleanup_verified, false);
    const journalName = (await readdir(path.join(root, 'journal'))).find((name) => name.endsWith('.json'));
    const journal = async () => JSON.parse(await readFile(path.join(root, 'journal', journalName), 'utf8'));
    assert.equal((await journal()).sandbox_state, 'unknown');
    assert.equal((await journal()).sandbox_absence_verified, false);
    const second = await opened(t);
    const restarted = new E2BRiskForkAdapter(adapterOptions(second.Sandbox));
    const recovered = await restarted.reconcilePendingCleanup();
    assert.deepEqual(recovered.unresolved, []);
    assert.equal(recovered.reconciled.length, 1);
    assert.equal((await journal()).sandbox_absence_verified, true);
    assert.equal((await journal()).export_absence_verified, true);
    await assert.rejects(readFile('/tmp/risk-fork-sdk-process-synthetic-orphan.json'), { code: 'ENOENT' });
    assert.equal(restarted.qualified, false, 'synthetic recovery is never provider qualification');
  });
}
