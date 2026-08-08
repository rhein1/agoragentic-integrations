import assert from 'node:assert/strict';
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
