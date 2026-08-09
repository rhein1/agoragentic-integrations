import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import test from 'node:test';

import {
  SUPPORTED_SKILLOPT_REVISION,
  SUPPORTED_SKILLOPT_VERSION,
  attachEvaluationEvidenceToReceipt,
  normalizeSkillOptSleepReport,
} from '../src/evaluations/index.mjs';
import { buildSkillOptTaskDraft } from '../src/memory-skillopt.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const memoryIds = [
  'mem_11111111111111111111111111111111',
  'mem_22222222222222222222222222222222',
  'mem_33333333333333333333333333333333',
];

function memoryExport() {
  const claim = (id, overrides = {}) => ({
    id,
    project_id: 'agoragentic-public',
    repo_id: 'rhein1/example',
    type: 'open_loop',
    state: 'open',
    title: `Task ${id.slice(-2)}`,
    summary: 'Run a bounded deterministic check and compare the public result.',
    next_action: 'Execute the local fixture and verify its expected public-safe output.',
    sensitivity: 'public',
    evidence: [{ evidence_id: `ev_${id.slice(4)}`, evidence_hash: `sha256:${'a'.repeat(64)}` }],
    evidence_total: 1,
    ...overrides,
  });
  return {
    schema: 'agoragentic.memory.export.v1',
    generated_at: '2026-08-09T00:00:00.000Z',
    authority: 'index_only_verify_sources',
    scope: 'bounded_current_state',
    limits: { claims_per_repository: 100, events_per_repository: 200 },
    excludes: ['mutation_receipts'],
    truncation_possible: true,
    repositories: [{ project_id: 'agoragentic-public', repo_id: 'rhein1/example' }],
    claims: [
      claim(memoryIds[0]),
      claim(memoryIds[1], { type: 'validation', state: 'verified_done' }),
      claim(memoryIds[2], { sensitivity: 'private', summary: 'must never leave the private ledger' }),
    ],
    events: [{ private_event_detail: 'must not be retained' }],
  };
}

function selection(ids = memoryIds.slice(0, 2)) {
  return {
    schema: 'agoragentic.memory-skillopt.selection.v1',
    memory_project_id: 'agoragentic-public',
    skillopt_project: 'agoragentic-fixture',
    target_skill_path: '.agents/skills/example/SKILL.md',
    tasks: [
      { memory_id: ids[0], split: 'train', skill_hint: 'example-skill' },
      { memory_id: ids[1], split: 'val', skill_hint: 'example-skill' },
    ],
  };
}

function skillOptReport(overrides = {}) {
  return {
    night: 1,
    accepted: true,
    gate_action: 'accept',
    no_edits_reason: '',
    baseline: 0.5,
    candidate: 0.75,
    n_tasks: 2,
    n_sessions: 0,
    n_accepted_edits: 1,
    n_rejected_edits: 0,
    edits: [{ content: 'private optimizer proposal must not be retained' }],
    rejected_edits: [],
    notes: ['private optimizer rationale must not be retained'],
    staging_dir: 'C:/private/staging',
    adopted: false,
    tasks_file: 'C:/private/tasks.json',
    tasks_reviewed: true,
    holdout_leaked: false,
    ...overrides,
  };
}

function receipt() {
  return {
    schema: 'agoragentic.harness.local-receipt.v1',
    receipt_id: 'local_receipt_fixture',
    proof_id: 'proof_fixture',
    created_at: '2026-08-09T00:00:00.000Z',
    mode: 'local_no_spend_receipt',
    status: 'recorded',
    spend: { amount_usdc: 0, settlement_network: 'none', settlement_status: 'not_applicable' },
    evidence: {
      agent_name: 'fixture-agent',
      primary_goal: 'evaluate a reviewed SkillOpt proposal',
      proof_status: 'passed',
      local_artifacts: ['agent.yaml'],
    },
    receipt_boundary: {
      router_invocation_created: false,
      x402_payment_attempted: false,
      marketplace_published: false,
      hosted_runtime_provisioned: false,
      memory_written: false,
    },
  };
}

function normalize(report) {
  return normalizeSkillOptSleepReport(report, {
    producer_version: SUPPORTED_SKILLOPT_VERSION,
    source_revision: SUPPORTED_SKILLOPT_REVISION,
    analyzed_revision: '0123456789abcdef0123456789abcdef01234567',
    source_ref: 'skillopt-report.json',
  });
}

test('public operator-selected memory claims produce a deterministic unreviewed SkillOpt task draft', () => {
  const first = buildSkillOptTaskDraft(memoryExport(), selection());
  const second = buildSkillOptTaskDraft(memoryExport(), selection());
  assert.deepEqual(first, second);
  assert.equal(first.format, 'skillopt_sleep.tasks.v1');
  assert.equal(first.reviewed, false);
  assert.equal(first.tasks.length, 2);
  assert.deepEqual(first.tasks.map((task) => task.split), ['train', 'val']);
  assert.equal(first.agoragentic_provenance.authority_boundary.call_provider, false);
  assert.equal(first.agoragentic_provenance.authority_boundary.adopt_skill, false);
  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /rhein1\/example/);
  assert.doesNotMatch(serialized, /private_event_detail/);
  assert.doesNotMatch(serialized, /must never leave the private ledger/);
  const privateVariant = memoryExport();
  privateVariant.events[0].private_event_detail = 'different private value';
  privateVariant.claims[2].summary = 'different private claim';
  assert.deepEqual(buildSkillOptTaskDraft(privateVariant, selection()), first);
});

test('private, unevidenced, and secret-shaped memories fail closed', () => {
  assert.throws(() => buildSkillOptTaskDraft(memoryExport(), selection([memoryIds[0], memoryIds[2]])), /not public/);
  const noEvidence = memoryExport();
  noEvidence.claims[0].evidence = [];
  noEvidence.claims[0].evidence_total = 0;
  assert.throws(() => buildSkillOptTaskDraft(noEvidence, selection()), /no evidence reference/);
  const secret = memoryExport();
  secret.claims[0].summary = 'Use token=not-safe-to-export-1234567890 for the task.';
  assert.throws(() => buildSkillOptTaskDraft(secret, selection()), /secret-shaped/);
  const duplicate = memoryExport();
  duplicate.claims.push({ ...duplicate.claims[0] });
  assert.throws(() => buildSkillOptTaskDraft(duplicate, selection()), /duplicate claim identity/);
});

test('SkillOpt report normalization is bounded, hash-only, and never adopts', () => {
  const evaluation = normalize(skillOptReport());
  assert.equal(evaluation.result, 'pass');
  assert.equal(evaluation.summary.total, 0);
  assert.equal(evaluation.authority_boundary.publish, false);
  const attached = attachEvaluationEvidenceToReceipt(receipt(), evaluation);
  assert.equal(attached.status, 'recorded');
  assert.equal(attached.receipt_boundary.memory_written, false);
  const serialized = JSON.stringify(attached);
  assert.doesNotMatch(serialized, /private optimizer proposal/);
  assert.doesNotMatch(serialized, /private optimizer rationale/);
  assert.doesNotMatch(serialized, /C:\/private/);
});

test('unreviewed, adopted, regressed, leaked, or incomplete reports fail or require review', () => {
  assert.throws(() => normalizeSkillOptSleepReport(skillOptReport(), {
    producer_version: '0.2.1',
    source_revision: SUPPORTED_SKILLOPT_REVISION,
    analyzed_revision: '0123456789abcdef0123456789abcdef01234567',
    source_ref: 'skillopt-report.json',
  }), /Unsupported SkillOpt version/);
  assert.equal(normalize(skillOptReport({ tasks_reviewed: false })).result, 'fail');
  assert.equal(normalize(skillOptReport({ adopted: true })).result, 'fail');
  assert.equal(normalize(skillOptReport({ candidate: 0.25 })).result, 'fail');
  assert.equal(normalize(skillOptReport({ holdout_leaked: true })).result, 'fail');
  assert.equal(normalize(skillOptReport({ gate_action: 'greedy_applied' })).result, 'fail');
  assert.equal(normalize(skillOptReport({ tasks_file: '' })).result, 'fail');
  const missingHoldout = skillOptReport();
  delete missingHoldout.holdout_leaked;
  assert.equal(normalize(missingHoldout).result, 'review');
  assert.equal(normalize(skillOptReport({ accepted: false, gate_action: 'reject', n_accepted_edits: 0 })).result, 'review');
  assert.equal(normalize(skillOptReport({ accepted: false, gate_action: 'reject', n_accepted_edits: 1 })).result, 'fail');
});

test('selection and task draft schemas accept the canonical bridge output', async () => {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const selectionSchema = JSON.parse(await readFile(path.join(root, 'schema', 'memory-skillopt-selection.v1.json'), 'utf8'));
  const taskSchema = JSON.parse(await readFile(path.join(root, 'schema', 'memory-skillopt-task-draft.v1.json'), 'utf8'));
  ajv.addSchema(selectionSchema);
  ajv.addSchema(taskSchema);
  assert.equal(ajv.validate(selectionSchema.$id, selection()), true, JSON.stringify(ajv.errors));
  const draft = buildSkillOptTaskDraft(memoryExport(), selection());
  assert.equal(ajv.validate(taskSchema.$id, draft), true, JSON.stringify(ajv.errors));
  draft.agoragentic_provenance.authority_boundary.execute = true;
  assert.equal(ajv.validate(taskSchema.$id, draft), false, 'unknown authority must be rejected');
});

test('CLI writes an exclusive unreviewed draft and attaches a bounded evaluation', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'memory-skillopt-'));
  const exportPath = path.join(temp, 'memory.json');
  const selectionPath = path.join(temp, 'selection.json');
  const taskPath = path.join(temp, 'tasks.json');
  const reportPath = path.join(temp, 'report.json');
  const receiptPath = path.join(temp, 'receipt.json');
  const attachedPath = path.join(temp, 'attached.json');
  await Promise.all([
    writeFile(exportPath, JSON.stringify(memoryExport())),
    writeFile(selectionPath, JSON.stringify(selection())),
    writeFile(reportPath, JSON.stringify(skillOptReport())),
    writeFile(receiptPath, JSON.stringify(receipt())),
  ]);
  const cli = path.join(root, 'bin', 'agoragentic-memory-skillopt.mjs');
  const exported = await execFileAsync(process.execPath, [
    cli, 'export-tasks', '--memory-export', exportPath, '--selection', selectionPath, '--output', taskPath,
  ]);
  assert.equal(JSON.parse(exported.stdout).reviewed, false);
  assert.equal(JSON.parse(await readFile(taskPath, 'utf8')).reviewed, false);
  await assert.rejects(
    execFileAsync(process.execPath, [cli, 'export-tasks', '--memory-export', exportPath, '--selection', selectionPath, '--output', taskPath]),
    /output already exists/,
  );
  const attached = await execFileAsync(process.execPath, [
    cli, 'attach-report', '--report', reportPath, '--receipt', receiptPath,
    '--producer-version', SUPPORTED_SKILLOPT_VERSION, '--source-revision', SUPPORTED_SKILLOPT_REVISION,
    '--analyzed-revision', '0123456789abcdef0123456789abcdef01234567', '--output', attachedPath,
  ]);
  assert.equal(JSON.parse(attached.stdout).result, 'pass');
  assert.equal(JSON.parse(await readFile(attachedPath, 'utf8')).evaluations.length, 1);
  await assert.rejects(
    execFileAsync(process.execPath, [
      cli, 'attach-report', '--report', reportPath, '--receipt', receiptPath,
      '--analyzed-revision', '0123456789abcdef0123456789abcdef01234567',
      '--output', path.join(temp, 'missing-provenance.json'),
    ]),
    /missing option: --producer-version/,
  );
});
