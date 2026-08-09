import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import { decideApproval } from 'agoragentic-harness-core';

import {
  OpenCodeGovernanceBlock,
  createOpenCodeHooks,
  decideOpenCodeToolCall,
  mapOpenCodeToolCall,
} from '../src/index.mjs';
import * as serverModule from '../src/server.mjs';

const require = createRequire(import.meta.url);
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contract = JSON.parse(await fs.readFile(
  path.join(packageRoot, 'contracts', 'opencode-plugin-1.18.15.json'),
  'utf8',
));
const packageJson = JSON.parse(await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const receiptSchema = JSON.parse(await fs.readFile(
  require.resolve('agoragentic-harness-core/schema/local-receipt.v1.json'),
  'utf8',
));
const validateReceipt = new Ajv({ allErrors: true, strict: false }).compile(receiptSchema);

test('package exposes only the exact pinned OpenCode server entry contract', async () => {
  assert.equal(contract.source_commit, '38e10eb1408feb700021b8e8766fb0ab41bf84e2');
  assert.equal(contract.opencode_version, '1.18.15');
  assert.equal(contract.plugin_package_version, '1.18.15');
  assert.equal(contract.package_entry.export, './server');
  assert.equal(contract.compatibility_claim, 'fixture_only_not_end_to_end_runtime_verification');
  assert.equal(packageJson.engines.opencode, '=1.18.15');
  assert.equal(packageJson.exports['./server'], './src/server.mjs');
  assert.deepEqual(Object.keys(serverModule), ['default']);
  assert.equal(serverModule.default.id, '@agoragentic/opencode');
  assert.equal(typeof serverModule.default.server, 'function');

  const directory = await tempDir();
  const hooks = await serverModule.default.server({ directory }, { policy: {} });
  assert.deepEqual(Object.keys(hooks).sort(), ['tool.execute.after', 'tool.execute.before']);
  assert.equal(typeof hooks['tool.execute.before'], 'function');
  assert.equal(typeof hooks['tool.execute.after'], 'function');
  assert.equal('tool' in hooks, false, 'the package must not register hosted/API execution tools');
});

test('a destructive tool call is denied before the simulated side effect', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_000_000]) },
  });
  let executed = false;
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error('network disabled in hermetic test');
  };

  try {
    await assert.rejects(
      hooks['tool.execute.before'](
        hookInput('bash', 'session-deny', 'call-deny'),
        { args: { command: 'git push origin main' } },
      ),
      (error) => {
        assert.ok(error instanceof OpenCodeGovernanceBlock);
        assert.equal(error.code, 'policy_denied');
        assert.equal(error.decision, 'deny');
        return true;
      },
    );
    executed = false;
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(executed, false);
  assert.equal(fetchCalls, 0);
  const events = await readJsonLines(await onlyFile(directory, 'events.jsonl'));
  assert.equal(events[0].type, 'before_tool');
  assert.equal(events[0].severity, 'blocked');
  assert.equal(events[0].data.enforcement_decision, 'deny');
  const receipt = await onlyReceipt(directory, (candidate) => candidate.outcome_status === 'denied');
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.receipt_claims.settlement_receipt, false);
  assert.equal(receipt.receipt_claims.certification, false);
  assert.equal(receipt.receipt_claims.marketplace_verification, false);
  assertSchemaValid(receipt);
});

test('ask writes one bounded packet, blocks, and an approved retry can complete', async () => {
  const directory = await tempDir();
  const inputSecret = 'DO_NOT_PERSIST_INPUT_7f3e';
  const outputSecret = 'DO_NOT_PERSIST_OUTPUT_9b1c';
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    options: { memory_handoff: 'local_ref' },
    internals: {
      now_ms: fixedClock([
        1_700_000_100_000,
        1_700_000_101_000,
        1_700_000_101_250,
        1_700_000_102_000,
      ]),
    },
  });
  const input = hookInput('write', 'session-ask', 'call-ask');
  const args = {
    filePath: 'bounded.txt',
    content: inputSecret,
    api_key: inputSecret,
  };

  let block;
  try {
    await hooks['tool.execute.before'](input, { args });
    assert.fail('write should require approval before execution');
  } catch (error) {
    block = error;
  }
  assert.ok(block instanceof OpenCodeGovernanceBlock);
  assert.equal(block.code, 'approval_required');
  assert.match(block.message, /then retry the tool call/);
  assert.doesNotMatch(block.message, new RegExp(inputSecret));

  const approvalPath = path.join(directory, '.agoragentic', 'approvals', `${block.approval_id}.json`);
  const packetText = await fs.readFile(approvalPath, 'utf8');
  const packet = JSON.parse(packetText);
  assert.ok(Buffer.byteLength(packetText, 'utf8') < 16_384, 'approval packet must stay bounded');
  assert.equal(packet.status, 'pending');
  assert.equal(packet.requested_action.host, 'opencode');
  assert.equal(packet.requested_action.tool_name, 'write');
  assert.equal(packet.requested_action.capability, 'filesystem_write');
  assert.equal(packet.requested_action.raw_input_persisted, false);
  assert.equal(packet.requested_action.input_evidence.storage, 'hash_and_shape_only');
  assert.deepEqual(packet.required_approvals, ['owner']);
  assert.doesNotMatch(packetText, new RegExp(inputSecret));

  await decideApproval({
    dir: directory,
    approval_id: block.approval_id,
    decision: 'approve',
    note: 'owner-reviewed local retry',
  });

  let simulatedExecutions = 0;
  await hooks['tool.execute.before'](input, { args });
  simulatedExecutions += 1;
  await hooks['tool.execute.after'](
    { ...input, args },
    {
      title: outputSecret,
      output: outputSecret,
      metadata: { token: outputSecret, nested: { secret: outputSecret } },
    },
  );
  assert.equal(simulatedExecutions, 1);

  const success = await onlyReceipt(directory, (candidate) => candidate.outcome_status === 'succeeded');
  assert.equal(success.status, 'recorded');
  assert.equal(success.evidence.policy_decision, 'ask');
  assert.equal(success.evidence.enforcement_decision, 'allow_after_local_approval');
  assert.equal(success.evidence.raw_tool_input_persisted, false);
  assert.equal(success.evidence.raw_tool_output_persisted, false);
  assert.equal(success.evidence.output_evidence.storage, 'hash_and_shape_only');
  assert.equal(success.duration_ms, 250);
  assert.ok(success.approval_refs.some((ref) => ref.endsWith(`${block.approval_id}.decision.json`)));
  assertSchemaValid(success);

  let replayBlock;
  try {
    await hooks['tool.execute.before'](input, { args });
    assert.fail('a consumed approval must not authorize a second execution');
  } catch (error) {
    replayBlock = error;
  }
  assert.ok(replayBlock instanceof OpenCodeGovernanceBlock);
  assert.equal(replayBlock.code, 'approval_required');
  assert.notEqual(replayBlock.approval_id, block.approval_id);

  const artifactText = await readAllText(path.join(directory, '.agoragentic'));
  assert.doesNotMatch(artifactText, new RegExp(inputSecret));
  assert.doesNotMatch(artifactText, new RegExp(outputSecret));
  assert.match(artifactText, /agoragentic\.harness\.opencode-memory-handoff\.v1/);
  assert.match(artifactText, /"memory_write_performed": false/);
});

test('changed after-hook arguments emit blocked mismatch evidence instead of a success receipt', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_125_000, 1_700_000_125_300]) },
  });
  const input = hookInput('read', 'session-binding', 'call-binding');
  const governedArgs = { filePath: 'README.md' };
  const executedArgs = { filePath: 'private/changed-after-before.md' };

  await hooks['tool.execute.before'](input, { args: governedArgs });
  await hooks['tool.execute.after'](
    { ...input, args: executedArgs },
    { title: 'Read', output: 'bounded output only' },
  );

  const receipt = await onlyReceipt(
    directory,
    (candidate) => candidate.outcome_status === 'governance_binding_mismatch',
  );
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.evidence.governance_binding.valid, false);
  assert.equal(receipt.evidence.governance_binding.tool_name_matches_governed_before, true);
  assert.notEqual(
    receipt.evidence.governance_binding.governed_input_hash,
    receipt.evidence.governance_binding.executed_input_hash,
  );
  assert.ok(receipt.evidence.reason_codes.includes('arguments_changed_after_governance'));
  assertSchemaValid(receipt);
  assert.doesNotMatch(
    await readAllText(path.join(directory, '.agoragentic')),
    /private\/changed-after-before\.md/,
  );

  await assert.rejects(
    hooks['tool.execute.before'](
      hookInput('read', 'session-binding-next', 'call-binding-next'),
      { args: { filePath: 'README.md' } },
    ),
    (error) => error instanceof OpenCodeGovernanceBlock && error.code === 'evidence_unavailable',
  );
});

test('an approved action cannot be injected into a different action reference', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: {
      now_ms: fixedClock([
        1_700_000_127_000,
        1_700_000_127_100,
        1_700_000_127_200,
        1_700_000_127_300,
      ]),
    },
  });
  const benignInput = hookInput('write', 'session-cross-binding', 'call-benign');
  const dangerousInput = hookInput('webfetch', 'session-cross-binding', 'call-dangerous');
  const benignArgs = { filePath: 'benign.txt', content: 'bounded' };
  const dangerousArgs = { url: 'https://example.invalid/dangerous' };

  const benignApproval = await requestApproval(hooks, benignInput, benignArgs);
  const dangerousApproval = await requestApproval(hooks, dangerousInput, dangerousArgs);
  await decideApproval({
    dir: directory,
    approval_id: benignApproval.approval_id,
    decision: 'approve',
    note: 'owner-reviewed benign write only',
  });

  const benignRefPath = await approvalRefPathForApproval(directory, benignApproval.approval_id);
  const dangerousRefPath = await approvalRefPathForApproval(directory, dangerousApproval.approval_id);
  const benignRef = JSON.parse(await fs.readFile(benignRefPath, 'utf8'));
  const dangerousRef = JSON.parse(await fs.readFile(dangerousRefPath, 'utf8'));
  assert.notEqual(benignRef.action_fingerprint, dangerousRef.action_fingerprint);
  assert.notEqual(benignRef.approval_binding.binding_ref, dangerousRef.approval_binding.binding_ref);

  // Preserve the current action fingerprint and ref binding while injecting a
  // different approved packet. The underlying packet must still reject it.
  await fs.writeFile(dangerousRefPath, `${JSON.stringify({
    ...dangerousRef,
    approval_id: benignRef.approval_id,
    approval_ref: benignRef.approval_ref,
  }, null, 2)}\n`, 'utf8');
  await assert.rejects(
    hooks['tool.execute.before'](dangerousInput, { args: dangerousArgs }),
    (error) => error instanceof OpenCodeGovernanceBlock && error.code === 'approval_binding_invalid',
  );

  // Rewriting the mutable reference fields together also fails before the
  // approved packet can be claimed.
  await fs.writeFile(dangerousRefPath, `${JSON.stringify(benignRef, null, 2)}\n`, 'utf8');
  await assert.rejects(
    hooks['tool.execute.before'](dangerousInput, { args: dangerousArgs }),
    (error) => error instanceof OpenCodeGovernanceBlock && error.code === 'approval_binding_invalid',
  );
});

test('apply_patch inspects every target and fails closed when targets cannot be parsed', async () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: public/safe.md',
    '@@',
    '-old',
    '+new',
    '*** Update File: private/blocked.md',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const action = mapOpenCodeToolCall(
    hookInput('apply_patch', 'session-patch', 'call-patch'),
    { args: { patch } },
  );
  assert.deepEqual(action.targets, ['public/safe.md', 'private/blocked.md']);
  assert.equal(action.target, 'public/safe.md\nprivate/blocked.md');
  const decision = decideOpenCodeToolCall(
    { tool_policy: { blocked_paths: ['private/blocked.md'] } },
    hookInput('apply_patch', 'session-patch', 'call-patch'),
    { args: { patch } },
  );
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reasons.some((reason) => reason.code === 'blocked_path'));

  const malformed = decideOpenCodeToolCall(
    {},
    hookInput('apply_patch', 'session-patch-malformed', 'call-patch-malformed'),
    { args: { patch: 'not an apply_patch directive' } },
  );
  assert.equal(malformed.decision, 'deny');
  assert.ok(malformed.reasons.some((reason) => reason.code === 'apply_patch_targets_unparseable'));
});

test('Windows matches every parsed apply_patch target case-insensitively without widening POSIX matching', () => {
  const patch = [
    '*** Begin Patch',
    '*** Update File: PRIVATE\\BLOCKED.MD',
    '@@',
    '-old',
    '+new',
    '*** End Patch',
  ].join('\n');
  const policy = { tool_policy: { blocked_paths: ['private\\blocked.md'] } };
  const input = hookInput('apply_patch', 'session-case', 'call-case');
  const win32 = decideOpenCodeToolCall(policy, input, { args: { patch } }, { platform: 'win32' });
  assert.equal(win32.decision, 'deny');
  assert.ok(win32.reasons.some((reason) => reason.code === 'blocked_path'));

  const linux = decideOpenCodeToolCall(policy, input, { args: { patch } }, { platform: 'linux' });
  assert.equal(linux.decision, 'ask');
  assert.equal(linux.reasons.some((reason) => reason.code === 'blocked_path'), false);
});

test('underscored MCP money tool names are tokenized and denied before execution', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_130_000]) },
  });
  const input = hookInput('mcp__wallet__transfer', 'session-mcp-money', 'call-mcp-money');
  const decision = decideOpenCodeToolCall({}, input, { args: {} });
  assert.equal(decision.decision, 'deny');
  assert.ok(decision.reasons.some((reason) => reason.code === 'spend_or_publish_action'));

  await assert.rejects(
    hooks['tool.execute.before'](input, { args: {} }),
    (error) => error instanceof OpenCodeGovernanceBlock && error.code === 'policy_denied',
  );
});

test('two plugin instances cannot consume one approval twice', async () => {
  const directory = await tempDir();
  const input = hookInput('write', 'session-approval-race', 'call-approval-race');
  const args = { filePath: 'one-shot.txt', content: 'bounded' };
  const seed = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_135_000]) },
  });

  let requested;
  try {
    await seed['tool.execute.before'](input, { args });
    assert.fail('write should require approval before execution');
  } catch (error) {
    requested = error;
  }
  assert.ok(requested instanceof OpenCodeGovernanceBlock);
  assert.equal(requested.code, 'approval_required');
  await decideApproval({
    dir: directory,
    approval_id: requested.approval_id,
    decision: 'approve',
    note: 'owner-reviewed one-shot retry',
  });

  let arrivals = 0;
  let releaseClaims;
  const claimsReleased = new Promise((resolve) => { releaseClaims = resolve; });
  const waitForBothClaims = async () => {
    arrivals += 1;
    if (arrivals === 2) releaseClaims();
    await claimsReleased;
  };
  const first = createOpenCodeHooks({
    directory,
    policy: {},
    internals: {
      now_ms: fixedClock([1_700_000_135_100]),
      before_approval_claim: waitForBothClaims,
    },
  });
  const second = createOpenCodeHooks({
    directory,
    policy: {},
    internals: {
      now_ms: fixedClock([1_700_000_135_100]),
      before_approval_claim: waitForBothClaims,
    },
  });

  const attempts = await Promise.allSettled([
    first['tool.execute.before'](input, { args }),
    second['tool.execute.before'](input, { args }),
  ]);
  assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = attempts.find((result) => result.status === 'rejected');
  assert.ok(rejected?.reason instanceof OpenCodeGovernanceBlock);
  assert.equal(rejected.reason.code, 'approval_consumed');

  const approvalRefFiles = (await listFiles(path.join(directory, '.agoragentic', 'opencode', 'approval-refs')))
    .map((file) => path.basename(file));
  assert.equal(approvalRefFiles.filter((name) => /\.consumed_[a-f0-9]{12}\.json$/.test(name)).length, 1);
});

test('pending governed before records are bounded and expire without implying completion', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: {
      now_ms: fixedClock([0, 1, 2, 20]),
      pending_call_limit: 2,
      pending_call_ttl_ms: 10,
    },
  });

  await hooks['tool.execute.before'](hookInput('read', 'session-pending', 'call-one'), { args: { filePath: 'one.md' } });
  await hooks['tool.execute.before'](hookInput('read', 'session-pending', 'call-two'), { args: { filePath: 'two.md' } });
  await assert.rejects(
    hooks['tool.execute.before'](hookInput('read', 'session-pending', 'call-three'), { args: { filePath: 'three.md' } }),
    (error) => error instanceof OpenCodeGovernanceBlock && error.code === 'pending_completion_evidence_limit',
  );

  await hooks['tool.execute.before'](hookInput('read', 'session-pending', 'call-after-expiry'), { args: { filePath: 'after-expiry.md' } });
});

test('the installed Harness CLI shows and decides an OpenCode approval in the explicit project directory', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_140_000, 1_700_000_140_100]) },
  });
  const input = hookInput('write', 'session-cli', 'call-cli');
  const args = { filePath: 'cli-approved.txt', content: 'bounded' };

  let requested;
  try {
    await hooks['tool.execute.before'](input, { args });
    assert.fail('write should require approval before execution');
  } catch (error) {
    requested = error;
  }
  assert.ok(requested instanceof OpenCodeGovernanceBlock);
  assert.equal(requested.code, 'approval_required');

  const harnessCli = path.join(
    packageRoot,
    'node_modules',
    'agoragentic-harness-core',
    'bin',
    'agoragentic-harness.mjs',
  );
  const show = runHarnessCli(harnessCli, ['approvals', 'show', requested.approval_id, '--dir', directory]);
  assert.equal(show.status, 0, show.stderr);
  assert.equal(JSON.parse(show.stdout).approval.request.approval_id, requested.approval_id);

  const decide = runHarnessCli(harnessCli, [
    'approvals',
    'decide',
    requested.approval_id,
    '--decision',
    'approve',
    '--note',
    'owner-reviewed CLI retry',
    '--dir',
    directory,
  ]);
  assert.equal(decide.status, 0, decide.stderr);
  await hooks['tool.execute.before'](input, { args });
});

test('an after hook without a matching governed before hook blocks evidence and future calls', async () => {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_150_000, 1_700_000_150_100]) },
  });
  const input = hookInput('read', 'session-orphan', 'call-orphan');
  const secret = 'DO_NOT_PERSIST_ORPHAN_OUTPUT_54df';

  await hooks['tool.execute.after'](
    { ...input, args: { filePath: 'README.md' } },
    { title: 'Read', output: secret, metadata: { token: secret } },
  );

  const blocked = await onlyReceipt(
    directory,
    (candidate) => candidate.outcome_status === 'ungoverned_after_without_before',
  );
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.evidence.policy_decision, 'unknown');
  assert.equal(blocked.evidence.enforcement_decision, 'unknown');
  assert.equal(blocked.duration_observed, false);
  assert.equal(blocked.receipt_claims.settlement_receipt, false);
  assertSchemaValid(blocked);
  assert.doesNotMatch(await readAllText(path.join(directory, '.agoragentic')), new RegExp(secret));

  await assert.rejects(
    hooks['tool.execute.before'](
      hookInput('read', 'session-after-orphan', 'call-after-orphan'),
      { args: { filePath: 'README.md' } },
    ),
    (error) => {
      assert.ok(error instanceof OpenCodeGovernanceBlock);
      assert.equal(error.code, 'evidence_unavailable');
      return true;
    },
  );
});

test('successful fixture emits a deterministic schema-valid local receipt', async () => {
  const first = await runDeterministicSuccessFixture();
  const second = await runDeterministicSuccessFixture();

  assert.deepEqual(first, second);
  assert.equal(first.schema, 'agoragentic.harness.local-receipt.v1');
  assert.equal(first.settlement_status, 'not_settlement_receipt');
  assert.equal(first.receipt_class, 'local_policy_evidence_only');
  assert.equal(first.outcome_status, 'succeeded');
  assert.equal(first.duration_ms, 300);
  assert.equal(first.duration_observed, true);
  assert.match(first.hashes.input, /^sha256:[a-f0-9]{64}$/);
  assert.match(first.hashes.output, /^sha256:[a-f0-9]{64}$/);
  assert.equal(first.receipt_boundary.router_invocation_created, false);
  assert.equal(first.receipt_boundary.x402_payment_attempted, false);
  assert.equal(first.receipt_boundary.memory_written, false);
  assert.equal(first.authority_boundary.wallet_spend, false);
  assert.equal(first.authority_boundary.marketplace_publication, false);
  assertSchemaValid(first);
});

test('package source has no network, process, secret, or paid execution imports', async () => {
  const sourceFiles = [
    'src/index.mjs',
    'src/mapping.mjs',
    'src/runtime.mjs',
    'src/server.mjs',
  ];
  const source = (await Promise.all(sourceFiles.map((file) => fs.readFile(path.join(packageRoot, file), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /node:(?:http|https|net|tls|child_process)/);
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /AGORAGENTIC_API_KEY|WALLET_PRIVATE_KEY|PRIVATE_KEY/);
  assert.doesNotMatch(source, /client\.app|context\?\.client|context\.client/);
});

async function runDeterministicSuccessFixture() {
  const directory = await tempDir();
  const hooks = createOpenCodeHooks({
    directory,
    policy: {},
    internals: { now_ms: fixedClock([1_700_000_200_000, 1_700_000_200_300]) },
  });
  const input = hookInput('read', 'session-success', 'call-success');
  const args = { filePath: 'README.md' };
  await hooks['tool.execute.before'](input, { args });
  await hooks['tool.execute.after'](
    { ...input, args },
    { title: 'Read', output: 'bounded fixture output', metadata: { truncated: false } },
  );
  return onlyReceipt(directory, (candidate) => candidate.outcome_status === 'succeeded');
}

function hookInput(tool, sessionID, callID) {
  return { tool, sessionID, callID };
}

function fixedClock(values) {
  const remaining = [...values];
  const fallback = remaining.at(-1) ?? 0;
  return () => remaining.shift() ?? fallback;
}

function runHarnessCli(harnessCli, args) {
  const result = spawnSync(process.execPath, [harnessCli, ...args], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}

async function requestApproval(hooks, input, args) {
  let requested;
  try {
    await hooks['tool.execute.before'](input, { args });
    assert.fail('the action should require approval before execution');
  } catch (error) {
    requested = error;
  }
  assert.ok(requested instanceof OpenCodeGovernanceBlock);
  assert.equal(requested.code, 'approval_required');
  return requested;
}

async function approvalRefPathForApproval(directory, approvalId) {
  const root = path.join(directory, '.agoragentic', 'opencode', 'approval-refs');
  const files = (await listFiles(root)).filter((file) => file.endsWith('.json'));
  const matches = [];
  for (const file of files) {
    const candidate = JSON.parse(await fs.readFile(file, 'utf8'));
    if (candidate.approval_id === approvalId && !candidate.consumed_at) matches.push(file);
  }
  assert.equal(matches.length, 1, `expected one approval ref for ${approvalId}, found ${matches.length}`);
  return matches[0];
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'agoragentic-opencode-'));
}

async function onlyReceipt(directory, predicate) {
  const files = (await listFiles(path.join(directory, '.agoragentic')))
    .filter((file) => /[\\/]receipts[\\/].+\.json$/.test(file));
  const receipts = await Promise.all(files.map(async (file) => JSON.parse(await fs.readFile(file, 'utf8'))));
  const matches = receipts.filter(predicate);
  assert.equal(matches.length, 1, `expected one matching receipt, found ${matches.length}`);
  return matches[0];
}

async function onlyFile(directory, basename) {
  const files = (await listFiles(path.join(directory, '.agoragentic')))
    .filter((file) => path.basename(file) === basename);
  assert.equal(files.length, 1, `expected one ${basename}, found ${files.length}`);
  return files[0];
}

async function listFiles(root) {
  const output = [];
  async function visit(current) {
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const target = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(target);
      else output.push(target);
    }
  }
  await visit(root);
  return output;
}

async function readJsonLines(filePath) {
  return (await fs.readFile(filePath, 'utf8'))
    .split(/\r?\n/)
    .filter(Boolean)
    .map(JSON.parse);
}

async function readAllText(root) {
  const files = await listFiles(root);
  return (await Promise.all(files.map((file) => fs.readFile(file, 'utf8')))).join('\n');
}

function assertSchemaValid(receipt) {
  assert.equal(
    validateReceipt(receipt),
    true,
    new Ajv({ allErrors: true }).errorsText(validateReceipt.errors),
  );
}
