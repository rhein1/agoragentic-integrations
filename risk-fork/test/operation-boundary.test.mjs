import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LocalReferenceRiskForkAdapter,
  inspectLocalWorkspace,
} from '../src/adapters/local-reference.mjs';
import {
  validateChildOperation,
  validateLocalReferenceOperation,
} from '../src/child-operation.mjs';
import { RiskForkController } from '../src/controller.mjs';
import { REQUIRED_PROVIDER_METHODS, RiskForkProvider } from '../src/provider.mjs';
import { NOW, hash, makeCapsule, makeForkIdentity } from './helpers.mjs';

const runnerPath = fileURLToPath(new URL('../src/adapters/local-runner.mjs', import.meta.url));

function countingProvider() {
  const provider = new RiskForkProvider({
    id: 'operation-boundary-counter',
    capabilities: {
      supports_filesystem_snapshot: true,
      supports_network_policy: true,
      supports_verified_destruction: true,
      isolation_class: 'test_counter',
    },
  });
  provider.calls = 0;
  for (const method of REQUIRED_PROVIDER_METHODS) {
    provider[method] = async () => {
      provider.calls += 1;
      throw new Error(`unexpected provider call: ${method}`);
    };
  }
  return provider;
}

function highRiskInput(capsule, operation) {
  return {
    risk_input: {
      mcp_phase: capsule.proposed_interaction.mcp_method,
      mcp_server_ref: capsule.proposed_interaction.mcp_server_ref,
      mcp_server_origin: capsule.proposed_interaction.mcp_server_origin,
      mcp_server_trust: 'verified',
      tool_name: capsule.proposed_interaction.tool_name,
      tool_annotations: { openWorldHint: false },
      capabilities: { filesystem_write: true },
    },
    capsule,
    savepoint_input: {},
    operation,
    effective_arguments: { value: 1 },
    expected_commit_type: 'TYPED_RESULT',
    commit_policy: { typed_result_schema_hash: capsule.authorized_result_schema_hash },
    network_policy: { mode: 'blocked' },
  };
}

async function verifyLocalAuthorityFreeSource(request) {
  return {
    schema: 'agoragentic.risk-fork.local-authority-free-attestation.v1',
    status: 'verified',
    request_hash: request.request_hash,
    capsule_hash: request.capsule_hash,
    workspace_digest: request.workspace_digest,
    evidence_ref: 'operation-boundary-source:evidence',
    evidence_hash: hash(request.request_hash),
    claims: {
      authority_free: true,
      credentials_absent: true,
      wallet_material_absent: true,
      execution_authority_absent: true,
    },
  };
}

function runLocalRunner(workspace, operation) {
  return new Promise((resolve, reject) => {
    const env = { RISK_FORK_NETWORK: 'blocked' };
    for (const key of ['SystemRoot', 'WINDIR']) {
      if (typeof process.env[key] === 'string') env[key] = process.env[key];
    }
    const child = spawn(process.execPath, [runnerPath, workspace], {
      cwd: workspace,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(operation));
  });
}

test('provider-neutral child operation validation is canonical, authority-free, and E2B-compatible', () => {
  const generic = validateChildOperation({
    kind: 'analyze',
    subject_ref: 'opaque:123',
    options: { max_tokens: 100 },
  });
  assert.deepEqual(generic, {
    kind: 'analyze',
    options: { max_tokens: 100 },
    subject_ref: 'opaque:123',
  });
  assert.equal(Object.isFrozen(generic), true);
  assert.equal(Object.isFrozen(generic.options), true);

  for (const operation of [
    { kind: 'analyze', api_key: 'sk-this-must-never-reach-a-child' },
    { kind: 'analyze', authorization: 'grant:opaque' },
    { kind: 'analyze', metadata: { executionAuthority: 'grant:opaque' } },
    { kind: 'analyze', content: 'api_key=abcdefghijklmnopqrstuvwxyz' },
  ]) {
    assert.throws(
      () => validateChildOperation(operation),
      /authority or secret-bearing field|authority or secret-shaped material/,
    );
  }

  const accessor = { kind: 'analyze' };
  Object.defineProperty(accessor, 'subject_ref', { enumerable: true, get: () => 'opaque:123' });
  assert.throws(() => validateChildOperation(accessor), /hidden or accessor field/);
});

test('child operation scans exact generated credentials in keys without echoing them', () => {
  const generatedKey = `amk_${'c'.repeat(64)}`;
  assert.throws(
    () => validateChildOperation({ kind: 'analyze', [`x${generatedKey}y`]: 'opaque' }),
    (error) => {
      assert.match(error.message, /authority or secret-shaped material/);
      assert.equal(error.message.includes(generatedKey), false);
      return true;
    },
  );

  const documented = validateChildOperation({
    kind: 'analyze',
    documentation: 'Use amk_your_api_key_here in examples only',
  });
  assert.equal(documented.documentation, 'Use amk_your_api_key_here in examples only');
});

test('controller rejects authority-bearing child operations before every provider call', async () => {
  const capsule = makeCapsule({ allowed_commit_types: ['TYPED_RESULT'] });
  for (const operation of [
    { kind: 'analyze', api_key: 'sk-this-must-never-reach-a-child' },
    { kind: 'analyze', authorization: 'grant:opaque' },
    {
      kind: 'bounded_file_batch',
      actions: [{
        type: 'write',
        path: 'safe.txt',
        content: 'authorization=Bearer abcdefghijklmnopqrstuvwxyz',
      }],
    },
  ]) {
    const provider = countingProvider();
    const controller = new RiskForkController({
      provider,
      mode: 'demonstration',
      clock: () => new Date(NOW),
    });
    await assert.rejects(
      controller.prepare(highRiskInput(capsule, operation)),
      /authority or secret-bearing field|authority or secret-shaped material/,
    );
    assert.equal(provider.calls, 0);
  }
});

test('local adapter rejects non-closed and secret-bearing batches before child mutation', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-operation-boundary-'));
  const source = path.join(temporary, 'source');
  await mkdir(source);
  await writeFile(path.join(source, 'safe.txt'), 'parent-original', 'utf8');
  const adapter = new LocalReferenceRiskForkAdapter({
    baseDirectory: path.join(temporary, 'adapter'),
    clock: () => new Date(NOW),
    verifyAuthorityFreeSource: verifyLocalAuthorityFreeSource,
  });
  try {
    const inspected = await inspectLocalWorkspace({ source_workspace: source });
    const capsule = makeCapsule({
      workspace: { snapshot_ref: 'workspace:local', digest: inspected.workspace_digest },
    });
    const savepoint = await adapter.createSavepoint({ capsule, source_workspace: source });
    const fork = await adapter.createFork({
      savepoint_ref: savepoint.savepoint_ref,
      fork_identity: makeForkIdentity(capsule),
      network_policy: { mode: 'blocked' },
      ttl_ms: 60_000,
    });

    assert.throws(
      () => validateLocalReferenceOperation({
        kind: 'bounded_file_batch',
        actions: [],
        unexpected: 'safe-looking-but-not-closed',
      }),
      /unsupported fields: unexpected/,
    );
    await assert.rejects(
      adapter.executeInFork({
        fork_ref: fork.fork_ref,
        execution_mode: 'isolated_execution',
        operation: {
          kind: 'bounded_file_batch',
          actions: [
            { type: 'write', path: 'safe.txt', content: 'would-have-mutated' },
            {
              type: 'write',
              path: 'leak.txt',
              content: 'api_key=abcdefghijklmnopqrstuvwxyz',
            },
          ],
        },
      }),
      /authority or secret-shaped material/,
    );
    assert.equal((await adapter.getForkStatus({ fork_ref: fork.fork_ref })).status, 'ready');
    assert.deepEqual((await adapter.collectDiff({ fork_ref: fork.fork_ref })).files, []);
    assert.equal(await readFile(path.join(source, 'safe.txt'), 'utf8'), 'parent-original');
  } finally {
    await adapter.dispose();
    await rm(temporary, { recursive: true, force: true });
  }
});

test('local runner independently validates the whole batch before its first write', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-runner-boundary-'));
  const target = path.join(temporary, 'safe.txt');
  await writeFile(target, 'runner-original', 'utf8');
  try {
    const secret = await runLocalRunner(temporary, {
      kind: 'bounded_file_batch',
      actions: [
        { type: 'write', path: 'safe.txt', content: 'would-have-mutated' },
        {
          type: 'write',
          path: 'leak.txt',
          content: 'authorization=Bearer abcdefghijklmnopqrstuvwxyz',
        },
      ],
    });
    assert.equal(secret.code, 1);
    assert.match(secret.stderr, /authority or secret-shaped material/);
    assert.equal(await readFile(target, 'utf8'), 'runner-original');

    const unknown = await runLocalRunner(temporary, {
      kind: 'bounded_file_batch',
      actions: [],
      metadata: { label: 'not-in-the-closed-envelope' },
    });
    assert.equal(unknown.code, 1);
    assert.match(unknown.stderr, /unsupported fields: metadata/);
    assert.equal(await readFile(target, 'utf8'), 'runner-original');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
