import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  FLIGHT_RECORDER_STATIC_ASSETS,
  createFlightRecorderServer,
  loadRecorderRecords,
  writeRecorderRecord,
} from '../src/flight-recorder.mjs';
import {
  DEMO_CLIENT_VERIFICATION_DETAILS,
  DEMO_CLIENTS,
  GENERATED_NOT_CLIENT_VERIFIED_STATUS,
  generateClientConfiguration,
  writeClientConfiguration,
} from '../src/config-generator.mjs';
import {
  RISK_FORK_DEMO_MCP_TOOLS,
  createMcpMessageHandler,
} from '../src/mcp-server.mjs';
import {
  RISK_FORK_DEMO_BANNER,
  RISK_FORK_DEMO_LIMITS,
  createDemoTruth,
  initializeOwnedDemoRoot,
  inspectOwnedDemoTree,
} from '../src/security.mjs';
import {
  RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES,
  RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES,
} from '../src/demo-engine.mjs';
import { sha256Ref } from '../../src/index.mjs';

function request({ origin, pathName = '/', token, hostileHost = false }) {
  return new Promise((resolve, reject) => {
    const requestValue = http.request({
      host: '127.0.0.1',
      port: origin.port,
      path: pathName,
      method: 'GET',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(origin.header ? { origin: origin.header } : {}),
        ...(hostileHost ? { host: 'attacker.invalid' } : {}),
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    requestValue.once('error', reject);
    requestValue.end();
  });
}

function sampleResult(runId = 'run_sample_1234') {
  const evidenceRef = `demo-tainted-output:${'5'.repeat(24)}`;
  const evidenceHash = `sha256:${'6'.repeat(64)}`;
  const result = {
    schema: 'agoragentic.risk-fork.hackathon-demo-result.v1',
    banner: RISK_FORK_DEMO_BANNER,
    ...createDemoTruth(),
    run_id: runId,
    scenario: { id: 'high-filesystem-write', title: 'Synthetic HIGH fixture' },
    action_summary: 'Synthetic write',
    final_state: 'prepared_not_committed',
    decision: {
      level: 'HIGH',
      action: 'RISK_FORK_REQUIRED',
      directive: 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK',
      score: 40,
      reasons: ['filesystem_write'],
      classifier: 'agoragentic-risk-fork-deterministic-v1',
      classifier_version: 'v1',
    },
    parent_state_hash: `sha256:${'1'.repeat(64)}`,
    savepoint_status: 'verified',
    fork_identity_hash: `sha256:${'2'.repeat(64)}`,
    execution_mode: 'local_reference_protocol_execution',
    isolation_boundary: false,
    taint_status: 'tainted_validated',
    tainted_output_evidence: {
      status: 'sanitized_hash_only',
      evidence_ref: evidenceRef,
      evidence_hash: evidenceHash,
      reference_bytes: Buffer.byteLength(evidenceRef, 'utf8'),
      hash_bytes: Buffer.byteLength(evidenceHash, 'utf8'),
      sanitized: true,
      raw_output_included: false,
      max_reference_bytes: RISK_FORK_DEMO_TAINT_EVIDENCE_MAX_REFERENCE_BYTES,
      max_hash_bytes: RISK_FORK_DEMO_TAINT_EVIDENCE_HASH_BYTES,
    },
    validation_status: 'verified',
    lifecycle: { states: ['REQUESTED', 'CLEAN_COMMIT_READY'], chain_head: `sha256:${'3'.repeat(64)}`, verified: true },
    cleanup: { requested: true, absence: 'observed', status: 'verified' },
    limits: structuredClone(RISK_FORK_DEMO_LIMITS),
    demo_receipt: null,
    exit_code: 0,
  };
  const receiptDraft = createDemoTruth({
    schema: 'agoragentic.risk-fork.hackathon-demo-receipt.v1',
    run_id: result.run_id,
    scenario_id: result.scenario.id,
    final_state: result.final_state,
    risk_decision_hash: `sha256:${'7'.repeat(64)}`,
    interception_plan_hash: `sha256:${'8'.repeat(64)}`,
    lifecycle_chain_head: result.lifecycle.chain_head,
    core_receipt_hash: null,
    core_receipt_verified: false,
    cleanup_status: result.cleanup.status,
    exit_code: result.exit_code,
    verified: true,
    demo_receipt_hash: null,
  });
  const {
    banner: _banner,
    demo_only: _demoOnly,
    local_protocol_simulator: _localProtocolSimulator,
    production_ready: _productionReady,
    live_traffic_protected: _liveTrafficProtected,
    authority_granted: _authorityGranted,
    provider_calls: _providerCalls,
    network_used: _networkUsed,
    credentials_used: _credentialsUsed,
    clean_commit_performed: _cleanCommitPerformed,
    ...receiptFields
  } = receiptDraft;
  result.demo_receipt = createDemoTruth({
    ...receiptFields,
    demo_receipt_hash: sha256Ref(receiptDraft),
  });
  return result;
}

function serializedRecordBytes(value) {
  return Buffer.byteLength(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function sampleResultWithSerializedBytes(runId, targetBytes) {
  const value = sampleResult(runId);
  value.bounded_test_padding = Array.from({ length: 66 }, () => '');
  const baseBytes = serializedRecordBytes(value);
  let remaining = targetBytes - baseBytes;
  assert.ok(remaining >= 0 && remaining <= 66 * 64_000, 'test fixture target is representable');
  value.bounded_test_padding = value.bounded_test_padding.map(() => {
    const count = Math.min(remaining, 64_000);
    remaining -= count;
    return 'x'.repeat(count);
  });
  assert.equal(remaining, 0);
  assert.equal(serializedRecordBytes(value), targetBytes);
  return value;
}

async function assertCleanRecorderLayout(handle, expectedRecordCount, expectedBytes) {
  const inventory = await inspectOwnedDemoTree(handle, {
    subpath: 'records',
    maxFiles: 12,
    maxBytes: RISK_FORK_DEMO_LIMITS.max_root_bytes,
  });
  assert.equal(inventory.file_count, expectedRecordCount);
  assert.equal(inventory.total_bytes, expectedBytes);
  assert.ok(inventory.entries.every((entry) => /^records\/[A-Za-z0-9_-]{8,100}\.json$/.test(entry.path)));
}

test('Flight Recorder is token-gated loopback replay with strict headers and no external assets', async (t) => {
  for (const [name, value] of Object.entries(FLIGHT_RECORDER_STATIC_ASSETS)) {
    assert.doesNotMatch(value, /(?:https?:)?\/\//i, `${name} contains an external URL`);
  }
  assert.match(FLIGHT_RECORDER_STATIC_ASSETS.JS, /decision\.classifier_version/);
  assert.match(FLIGHT_RECORDER_STATIC_ASSETS.JS, /record\.tainted_output_evidence/);
  const laneNames = [...FLIGHT_RECORDER_STATIC_ASSETS.JS.matchAll(/lane\('([^']+)'/g)]
    .map((match) => match[1]);
  assert.deepEqual(laneNames, [
    'Clean Parent',
    'Policy and Risk Decision',
    'Disposable Fork',
    'Evidence and Cleanup',
  ]);
  assert.doesNotMatch(FLIGHT_RECORDER_STATIC_ASSETS.JS, /Bounded Demo Limits/);
  assert.match(FLIGHT_RECORDER_STATIC_ASSETS.JS, /local_reference_protocol_execution/);
  assert.match(FLIGHT_RECORDER_STATIC_ASSETS.JS, /record\.isolation_boundary === false/);
  assert.doesNotMatch(FLIGHT_RECORDER_STATIC_ASSETS.JS, /receipt\.verified/);
  for (const key of Object.keys(RISK_FORK_DEMO_LIMITS)) {
    assert.match(FLIGHT_RECORDER_STATIC_ASSETS.JS, new RegExp(`limits\\.${key}\\b`));
  }
  const server = await createFlightRecorderServer({ records: [sampleResult()] });
  t.after(() => server.close());
  assert.equal(server.mode, 'REPLAY');
  assert.equal(server.origin, `http://127.0.0.1:${server.port}`);

  const page = await request({ origin: { port: server.port }, pathName: '/' });
  assert.equal(page.status, 200);
  assert.match(page.body, /REPLAY/);
  assert.match(page.body, new RegExp(RISK_FORK_DEMO_BANNER));
  assert.doesNotMatch(page.body, new RegExp(server.token));
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'], 'no-store, max-age=0');
  assert.equal(page.headers['x-content-type-options'], 'nosniff');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['access-control-allow-origin'], undefined);

  const missing = await request({ origin: { port: server.port }, pathName: '/api/records' });
  assert.equal(missing.status, 401);
  const hostileOrigin = await request({
    origin: { port: server.port, header: 'https://attacker.invalid' },
    pathName: '/api/records',
    token: server.token,
  });
  assert.equal(hostileOrigin.status, 403);
  const hostileHost = await request({
    origin: { port: server.port },
    pathName: '/api/records',
    token: server.token,
    hostileHost: true,
  });
  assert.equal(hostileHost.status, 403);
  const authorized = await request({
    origin: { port: server.port, header: server.origin },
    pathName: '/api/records',
    token: server.token,
  });
  assert.equal(authorized.status, 200);
  const replay = JSON.parse(authorized.body).records[0];
  assert.equal(replay.final_state, 'prepared_not_committed');
  assert.equal(replay.execution_mode, 'local_reference_protocol_execution');
  assert.equal(replay.isolation_boundary, false);
  assert.equal(replay.receipt_hash_verified, true);
  assert.equal(replay.receipt_binding_verified, true);
  assert.equal(replay.decision.classifier_version, 'v1');
  assert.deepEqual(replay.limits, RISK_FORK_DEMO_LIMITS);
  assert.equal(replay.tainted_output_evidence.status, 'sanitized_hash_only');
  assert.equal(replay.tainted_output_evidence.sanitized, true);
  assert.equal(replay.tainted_output_evidence.raw_output_included, false);
  assert.ok(replay.tainted_output_evidence.reference_bytes
    <= replay.tainted_output_evidence.max_reference_bytes);
  assert.equal(
    replay.tainted_output_evidence.hash_bytes,
    replay.tainted_output_evidence.max_hash_bytes,
  );
  assert.doesNotMatch(authorized.body, new RegExp(server.token));
});

test('recorder persists only bounded sanitized records beneath the owned root', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-recorder-test-'));
  t.after(() => rm(parent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25,
  }));
  const root = path.join(parent, 'owned');
  const handle = await initializeOwnedDemoRoot(root);
  const record = await writeRecorderRecord(handle, sampleResult('run_record_1234'));
  assert.equal(record.relative_path, 'records/run_record_1234.json');
  const loaded = await loadRecorderRecords(handle);
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].run_id, 'run_record_1234');
  assert.equal(loaded[0].receipt_hash_verified, true);
  assert.equal(loaded[0].receipt_binding_verified, true);
});

test('recorder rejects a persisted receipt with a forged verification marker or hash', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-recorder-tamper-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'owned');
  const handle = await initializeOwnedDemoRoot(root);
  const value = sampleResult('run_tampered_1234');
  const record = await writeRecorderRecord(handle, value);
  const tampered = structuredClone(value);
  tampered.receipt_hash_verified = true;
  tampered.demo_receipt.demo_receipt_hash = `sha256:${'0'.repeat(64)}`;
  await writeFile(path.join(root, ...record.relative_path.split('/')), `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  await assert.rejects(
    loadRecorderRecords(handle),
    (error) => error?.code === 'DEMO_RECORDER_RECEIPT_INVALID'
      && !error.message.includes(parent)
      && !error.message.includes(value.run_id),
  );
});

test('Flight Recorder cross-binds receipt fields to the replay record', async () => {
  const mismatches = [
    (value) => { value.run_id = 'run_outer_mismatch'; },
    (value) => { value.final_state = 'blocked'; },
    (value) => { value.exit_code = 2; },
    (value) => { value.lifecycle.chain_head = `sha256:${'9'.repeat(64)}`; },
  ];
  for (const mutate of mismatches) {
    const value = sampleResult();
    value.receipt_binding_verified = true;
    mutate(value);
    await assert.rejects(
      createFlightRecorderServer({ records: [value] }),
      (error) => error?.code === 'DEMO_RECORDER_RECEIPT_BINDING_INVALID',
    );
  }
});

test('recorder enforces its cumulative byte limit at the exact boundary before persistence', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-recorder-boundary-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const handle = await initializeOwnedDemoRoot(path.join(parent, 'owned'));
  const final = sampleResult('run_boundary_final');
  const finalBytes = serializedRecordBytes(final);
  const first = sampleResultWithSerializedBytes(
    'run_boundary_first',
    RISK_FORK_DEMO_LIMITS.max_recorder_bytes - finalBytes,
  );

  const firstWrite = await writeRecorderRecord(handle, first);
  assert.equal(firstWrite.cumulative_bytes, serializedRecordBytes(first));
  const finalWrite = await writeRecorderRecord(handle, final);
  assert.equal(finalWrite.cumulative_bytes, RISK_FORK_DEMO_LIMITS.max_recorder_bytes);
  await assert.rejects(
    writeRecorderRecord(handle, sampleResult('run_boundary_reject')),
    (error) => error?.code === 'DEMO_RECORDER_BYTE_LIMIT'
      && !error.message.includes(parent)
      && !error.message.includes('run_boundary_reject'),
  );
  await assertCleanRecorderLayout(handle, 2, RISK_FORK_DEMO_LIMITS.max_recorder_bytes);
});

test('recorder serializes concurrent writers and rejects cumulative overflow without temporary artifacts', async (t) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-recorder-race-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const handle = await initializeOwnedDemoRoot(path.join(parent, 'owned'));
  const recordBytes = Math.floor(RISK_FORK_DEMO_LIMITS.max_recorder_bytes * 0.6);
  const outcomes = await Promise.allSettled([
    writeRecorderRecord(handle, sampleResultWithSerializedBytes('run_race_first', recordBytes)),
    writeRecorderRecord(handle, sampleResultWithSerializedBytes('run_race_second', recordBytes)),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
  const rejection = outcomes.find((outcome) => outcome.status === 'rejected');
  assert.equal(rejection.reason?.code, 'DEMO_RECORDER_BYTE_LIMIT');
  assert.doesNotMatch(rejection.reason.message, new RegExp(parent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assertCleanRecorderLayout(handle, 1, recordBytes);
});

test('generated configurations use only local node plus the absolute pinned entrypoint', async (t) => {
  const entrypoint = path.resolve('risk-fork', 'hackathon', 'bin', 'risk-fork-demo.mjs');
  assert.equal(
    DEMO_CLIENT_VERIFICATION_DETAILS.codex,
    'codex_config_generated_not_live_client_verified',
  );
  for (const client of DEMO_CLIENTS) {
    const generated = generateClientConfiguration({ client, entrypoint });
    assert.equal(generated.command, 'node');
    assert.deepEqual(generated.args, [entrypoint, 'mcp']);
    assert.equal(generated.verification_status, GENERATED_NOT_CLIENT_VERIFIED_STATUS);
    assert.equal(generated.verification_detail, DEMO_CLIENT_VERIFICATION_DETAILS[client]);
    assert.match(generated.content, new RegExp(RISK_FORK_DEMO_BANNER));
    assert.match(generated.content, new RegExp(GENERATED_NOT_CLIENT_VERIFIED_STATUS));
    assert.match(generated.content, new RegExp(DEMO_CLIENT_VERIFICATION_DETAILS[client]));
    assert.doesNotMatch(generated.content, /\bnpx(?:\.cmd)?\b/i);
    assert.doesNotMatch(generated.content, /agoragentic-mcp/i);
    assert.equal(generated.writes_performed, false);
  }

  const parent = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-config-test-'));
  t.after(() => rm(parent, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 25,
  }));
  const handle = await initializeOwnedDemoRoot(path.join(parent, 'owned'));
  const preview = generateClientConfiguration({ client: 'codex', entrypoint });
  assert.equal((await writeClientConfiguration(handle, preview)).writes_performed, false);
  const written = await writeClientConfiguration(handle, preview, { yes: true });
  assert.equal(written.writes_performed, true);
  assert.equal(written.verification_status, GENERATED_NOT_CLIENT_VERIFIED_STATUS);
  assert.equal(written.verification_detail, DEMO_CLIENT_VERIFICATION_DETAILS.codex);
  assert.equal(written.output_ref, 'owned-demo-root:configs/codex-risk-fork-demo.toml');
});

test('MCP exposes only enumerated synthetic tools and rejects caller-added fields', async () => {
  const engine = {
    async plan(scenario) { return { ...sampleResult('plan_result_1234'), scenario: { id: scenario } }; },
    async run(scenario) { return { ...sampleResult('run_result_1234'), scenario: { id: scenario } }; },
    async getReceipt(runId) { return { ...createDemoTruth(), found: true, run_id: runId }; },
  };
  assert.equal(RISK_FORK_DEMO_MCP_TOOLS.some((tool) => tool.name === 'risk_fork_now'), false);
  assert.deepEqual(RISK_FORK_DEMO_MCP_TOOLS.map((tool) => tool.name), [
    'risk_fork_demo_list_scenarios',
    'risk_fork_demo_plan',
    'risk_fork_demo_run',
    'risk_fork_demo_receipt',
  ]);
  const handle = createMcpMessageHandler({ engine });
  const initialized = await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }));
  assert.match(initialized.result.instructions, new RegExp(RISK_FORK_DEMO_BANNER));
  const listed = await handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
  assert.equal(listed.result.tools.length, 4);
  const planned = await handle(JSON.stringify({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'risk_fork_demo_plan', arguments: { scenario: 'high-filesystem-write' } },
  }));
  assert.equal(planned.result.structuredContent.scenario.id, 'high-filesystem-write');
  const rejected = await handle(JSON.stringify({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'risk_fork_demo_run', arguments: { scenario: 'high-filesystem-write', command: 'whoami' } },
  }));
  assert.equal(rejected.error.code, -32602);
  assert.equal(JSON.stringify(rejected).includes('whoami'), false);
});
