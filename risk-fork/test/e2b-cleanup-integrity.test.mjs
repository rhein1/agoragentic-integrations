import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalize, sha256Ref as hash } from '../src/canonical.mjs';
import { E2BRiskForkAdapter } from '../src/adapters/e2b.mjs';
import { E2BCleanupJournal } from '../src/adapters/e2b-cleanup-journal.mjs';
import { inspectLocalWorkspace } from '../src/adapters/local-reference.mjs';
import { verifyImmutableWorkspaceExportDestroyed } from '../src/adapters/e2b-workspace-export.mjs';
import { makeCapsule } from './helpers.mjs';
import {
  E2B_ADAPTER_ARTIFACT_EVIDENCE_REF,
  E2B_EXTERNAL_BIRTH_CONTROLS, E2B_EXTERNAL_PROVIDER_CONTROLS,
  E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS, E2B_QUALIFICATION_CONTROLS,
  applyE2BExternalQualificationObservation, createE2BExternalQualificationObservationVerifier,
  createE2BQualificationEvidence, createE2BQualificationTrustVerifier,
  sha256BytesRef, validateE2BQualificationEvidence, verifyE2BQualificationTrust,
} from '../src/e2b-qualification.mjs';

const TEMPLATE = 'synthetic-cleanup-template';
const PROFILE = 'agoragentic.risk-fork.e2b-clean-template.v1';
const NOW = new Date('2030-01-01T00:00:03.000Z');
const keyHash = (key) => sha256BytesRef(key.export({ type: 'spki', format: 'der' }));
const signed = (payload, key) => ({
  ...payload, signature: sign(null, Buffer.from(canonicalize(payload)), key).toString('base64url'),
});

// Generated keys and claims are synthetic test fixtures, not qualification or spend authority.
function qualificationFixture(adapterArtifactHash = null) {
  let now = NOW;
  const external = new Set(['first_instruction_ipv4_egress_denied',
    'first_instruction_ipv6_egress_denied', 'cost_within_cap',
    ...E2B_EXTERNAL_BIRTH_CONTROLS, ...E2B_EXTERNAL_PROVIDER_CONTROLS]);
  const provisional = createE2BQualificationEvidence({
    provider: { name: 'e2b', project_ref_hash: hash('synthetic-project'), region: 'test-region' },
    sdk: { package: 'e2b', version: '2.39.0', integrity_hash: hash('synthetic-sdk') },
    template: { template_id_hash: hash(TEMPLATE), build_id_hash: hash('synthetic-build'),
      template_evidence_hash: hash('synthetic-template-evidence'), provenance_hash: hash('synthetic-provenance') },
    runtime: { bootstrap_artifact_hash: hash('synthetic-bootstrap'),
      runner_artifact_hash: hash('synthetic-runner'), boot_guard_artifact_hash: hash('synthetic-guard') },
    run: { approval_ref_hash: hash('synthetic-approval-not-authority'), run_ref_hash: hash('synthetic-run'),
      started_at: '2030-01-01T00:00:00.000Z', completed_at: '2030-01-01T00:00:01.000Z',
      sandbox_count: 1, synthetic_workspace: true },
    limits: { hard_ttl_ms: 60_000, idle_ttl_ms: 10_000, max_execution_ms: 5_000, max_cost_usd: '0.25' },
    observations: { fork_start_ms: 1, execution_ms: 1, cleanup_ms: 1, observed_cost_usd: null },
    controls: Object.fromEntries(E2B_QUALIFICATION_CONTROLS.map((key) => [key, external.has(key) ? 'unknown' : 'verified'])),
    cleanup: { kill_requested: 'verified', absence_verified: 'verified', orphan_reconciliation: 'verified' },
    evidence_refs: [
      ...Object.values(E2B_EXTERNAL_QUALIFICATION_EVIDENCE_REFS).map((ref) => ({ ref, hash: hash(ref) })),
      ...(adapterArtifactHash === null ? [] : [{ ref: E2B_ADAPTER_ARTIFACT_EVIDENCE_REF, hash: adapterArtifactHash }]),
    ],
  });
  const observerKeys = generateKeyPairSync('ed25519');
  const trustKeys = generateKeyPairSync('ed25519');
  const observerOptions = {
    publicKey: observerKeys.publicKey, publicKeyHash: keyHash(observerKeys.publicKey),
    clock: () => new Date(now), maxReceiptAgeMs: 60_000,
    audience: { profile: 'agoragentic.risk-fork.e2b-qualification',
      project_ref_hash: provisional.provider.project_ref_hash, run_ref_hash: provisional.run.run_ref_hash,
      template_id_hash: provisional.template.template_id_hash, template_build_id_hash: provisional.template.build_id_hash },
  };
  const observer = createE2BExternalQualificationObservationVerifier(observerOptions);
  const payload = observer.createPayload(provisional, {
    observed_at: '2030-01-01T00:00:02.000Z', issued_at: '2030-01-01T00:00:02.000Z',
    expires_at: '2030-01-01T00:00:30.000Z',
    observer_boundary: { producer_class: 'privileged_host_supervisor', status: 'verified',
      evidence_hash: hash('synthetic-boundary'), child_write_access: false, reusable_signing_authority_in_child: false },
    birth_controls: Object.fromEntries(E2B_EXTERNAL_BIRTH_CONTROLS.map((key) => [key,
      { status: 'verified', evidence_hash: hash(key) }])),
    first_instruction_ipv4_egress_denied: true, first_instruction_ipv6_egress_denied: true,
    ipv6_provider_denial: { status: 'verified', evidence_hash: hash('synthetic-ipv6') },
    provider_controls: Object.fromEntries(E2B_EXTERNAL_PROVIDER_CONTROLS.map((key) => [key,
      { status: 'verified', evidence_hash: hash(key) }])),
    cost: { provider_cap: { amount_usd: '0.25', evidence_hash: hash('synthetic-cap') },
      derived_estimate: { amount_usd: '0.01', evidence_hash: hash('synthetic-estimate') },
      aggregate_console_delta: { amount_usd: '0.01', evidence_hash: hash('synthetic-delta') },
      actual_sandbox: { status: 'finalized', amount_usd: '0.01', evidence_hash: hash('synthetic-cost') } },
  });
  const evidence = applyE2BExternalQualificationObservation(provisional, signed(payload, observerKeys.privateKey), observer);
  const verifier = createE2BQualificationTrustVerifier({ publicKey: trustKeys.publicKey, publicKeyHash: keyHash(trustKeys.publicKey) });
  const trust = signed(verifier.createPayload(evidence, {}, observer), trustKeys.privateKey);
  return { evidence, observer, verifier, trust, observerOptions,
    advance(value) { now = new Date(value); } };
}

async function directories(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-cleanup-integrity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory: path.join(root, 'journal'), exportsDirectory: path.join(root, 'exports') };
}

function adapterOptions(dirs, fixture = null) {
  return {
    cleanTemplateId: TEMPLATE, cleanTemplateHash: hash('synthetic-template-evidence'),
    cleanTemplateProvenanceHash: hash('synthetic-provenance'),
    trustedBootstrapArtifactHash: hash('synthetic-bootstrap'), trustedRunnerArtifactHash: hash('synthetic-runner'),
    workspaceExportDirectory: dirs.exportsDirectory, cleanupJournalDirectory: dirs.directory,
    verifyAuthorityFreeSource: async () => { throw new Error('not used during restart cleanup'); },
    clock: () => new Date(NOW),
    ...(fixture ? { qualificationEvidence: fixture.evidence, qualificationTrust: fixture.trust,
      qualificationTrustVerifier: fixture.verifier, externalQualificationObservationVerifier: fixture.observer } : {}),
  };
}

async function intent(dirs, overrides = {}) {
  const journal = new E2BCleanupJournal({ directory: dirs.directory, clock: () => new Date(NOW) });
  const metadata = { 'agoragentic.risk_fork.profile': PROFILE, 'agoragentic.risk_fork.cleanup_ref': 'synthetic-cleanup-ref' };
  const record = await journal.createIntent({ record_id: 'synthetic-record', cleanup_ref: 'synthetic-cleanup-ref',
    provider_id: 'e2b-clean-template-v1', template_id_hash: hash(TEMPLATE),
    metadata_hash: hash(metadata), export_id: 'synthetic-export', ...overrides });
  return { journal, record, metadata };
}

test('expired authentic qualification permits local-only journal recovery, not new effects or provider I/O', async (t) => {
  const fixture = qualificationFixture();
  const dirs = await directories(t);
  const { journal, record } = await intent(dirs);
  fixture.advance('2030-01-01T00:01:00.000Z');
  assert.throws(() => validateE2BQualificationEvidence(fixture.evidence, {}, fixture.observer), /expired/);
  assert.throws(() => verifyE2BQualificationTrust(fixture.evidence, fixture.trust, fixture.verifier, {}, fixture.observer), /expired/);
  const adapter = new E2BRiskForkAdapter(adapterOptions(dirs, fixture));
  assert.equal(adapter.qualificationEligible, false);
  assert.equal(adapter.qualified, false);
  const result = await adapter.reconcilePendingCleanup();
  assert.deepEqual(result, { reconciled: [record.record_id], unresolved: [] });
  const recovered = await journal.get(record.record_id);
  assert.equal(recovered.export_absence_verified, true);
  assert.equal(recovered.sandbox_absence_verified, true);
  adapter.qualificationEvidence = null;
  adapter.qualificationTrust = null;
  adapter.qualificationEligible = true;
  adapter.qualified = true;
  await assert.rejects(adapter.createSavepoint({}), /expired/);
  await assert.rejects(adapter.createFork({}), /source|watcher|disabled/i);
  await assert.rejects(adapter.executeInFork({}), /source|watcher|disabled/i);
  await assert.rejects(adapter.suspendFork({}), /source|watcher|disabled/i);
  // Caller-written public status hints are not the captured authorization state.
  assert.equal((await journal.listPending()).length, 0);
  fixture.advance(NOW);
  await assert.rejects(adapter.createSavepoint({}), /cleanup-only/,
    'a cleanup-only constructor must not regain new-effect authority if its clock moves backward');
});

test('adapter captures a host artifact pin for current and historical qualification without enabling live I/O', async (t) => {
  const artifactHash = hash('synthetic-artifact-not-loaded-code-proof');
  const fixture = qualificationFixture(artifactHash);
  const legacy = qualificationFixture();
  const dirs = await directories(t);
  const { record } = await intent(dirs);
  const options = { ...adapterOptions(dirs, fixture), trustedAdapterArtifactHash: artifactHash };
  const adapter = new E2BRiskForkAdapter(options);
  assert.equal(adapter.qualificationExpectedBindings.adapterArtifactHash, artifactHash);
  assert.equal(adapter.qualified, false);
  assert.throws(() => new E2BRiskForkAdapter({ ...options,
    trustedAdapterArtifactHash: hash('other-artifact') }), /adapter artifact/i);
  assert.throws(() => new E2BRiskForkAdapter({ ...adapterOptions(dirs, legacy),
    trustedAdapterArtifactHash: artifactHash }), /adapter artifact/i);
  assert.throws(() => new E2BRiskForkAdapter({ ...adapterOptions(dirs),
    trustedAdapterArtifactHash: artifactHash }), /qualification evidence and signed trust/i);
  adapter.qualificationExpectedBindings = {};
  adapter.qualificationEvidence = legacy.evidence;
  options.trustedAdapterArtifactHash = hash('mutated-host-options');
  fixture.advance('2030-01-01T00:01:00.000Z');
  assert.deepEqual(await adapter.reconcilePendingCleanup(), { reconciled: [record.record_id], unresolved: [] });
  assert.equal(adapter.qualificationEligible, false);
  await assert.rejects(adapter.createSavepoint({}), /cleanup-only/);
  const restarted = new E2BRiskForkAdapter({ ...adapterOptions(dirs, fixture), trustedAdapterArtifactHash: artifactHash });
  assert.equal(restarted.qualified, false);
  assert.equal(restarted.qualificationEligible, false);
  assert.deepEqual(await restarted.reconcilePendingCleanup(), { reconciled: [], unresolved: [] });
  assert.throws(() => new E2BRiskForkAdapter({ ...adapterOptions(dirs, fixture),
    trustedAdapterArtifactHash: hash('other-artifact') }), /adapter artifact/i);
  await assert.rejects(restarted.createFork({}), /source|watcher|disabled/i);
});

test('expiry does not strand an existing immutable savepoint or its request-bound absence proof',
  { skip: process.platform === 'win32' ? 'immutable export POSIX ownership profile requires Linux' : false }, async (t) => {
    const fixture = qualificationFixture();
    const dirs = await directories(t);
    const source = path.join(dirs.root, 'source');
    await mkdir(source);
    await writeFile(path.join(source, 'input.txt'), 'bounded synthetic workspace\n');
    const inspected = await inspectLocalWorkspace({ source_workspace: source });
    const options = adapterOptions(dirs, fixture);
    options.verifyAuthorityFreeSource = async (request) => ({
      schema: 'agoragentic.risk-fork.authority-free-source-attestation.v1', status: 'verified',
      request_hash: request.request_hash, evidence_ref: 'synthetic:source', evidence_hash: hash('synthetic-source'),
      workspace_digest: request.workspace_digest, workspace_manifest_hash: request.workspace_manifest_hash,
      trusted_bootstrap_artifact_hash: options.trustedBootstrapArtifactHash,
      trusted_runner_artifact_hash: options.trustedRunnerArtifactHash,
      claims: { authority_free: true, credentials_absent: true, wallet_material_absent: true,
        execution_authority_absent: true, workspace_manifest_verified: true,
        immutable_export_verified: true, trusted_runtime_artifacts_verified: true },
    });
    const adapter = new E2BRiskForkAdapter(options);
    const savepoint = await adapter.createSavepoint({ source_workspace: source,
      capsule: makeCapsule({ workspace: { digest: inspected.workspace_digest } }) });
    const restartSavepoint = await adapter.createSavepoint({ source_workspace: source,
      capsule: makeCapsule({ workspace: { digest: inspected.workspace_digest } }) });
    const pending = adapter.savepoints.get(restartSavepoint.savepoint_ref);
    await adapter.cleanupJournal.markExportUnknown(pending.record_id, 'SYNTHETIC_RESTART_FAULT');
    const exportBinding = { export_root: dirs.exportsDirectory, export_id: pending.export_record.export_id };
    assert.equal(await verifyImmutableWorkspaceExportDestroyed(exportBinding), false);
    fixture.advance('2030-01-01T00:01:00.000Z');
    const input = { savepoint_ref: savepoint.savepoint_ref };
    assert.equal((await adapter.destroySavepoint(input)).status, 'destroy_requested_observed');
    const evidence = await adapter.verifySavepointDestroyed(input);
    assert.equal(evidence.status, 'verified');
    assert.equal(evidence.resource_ref, savepoint.savepoint_ref);
    const restarted = new E2BRiskForkAdapter(options);
    const recovery = await restarted.reconcilePendingCleanup();
    assert.deepEqual(recovery.unresolved, []);
    assert.equal(recovery.reconciled.includes(pending.record_id), true);
    assert.equal(await verifyImmutableWorkspaceExportDestroyed(exportBinding), true);
    const finalRecord = await restarted.cleanupJournal.get(pending.record_id);
    assert.equal(finalRecord.export_absence_verified, true);
    assert.equal(finalRecord.sandbox_absence_verified, true);
    await assert.rejects(adapter.createSavepoint({}), /expired/);
    assert.equal(adapter.qualified, false);
  });

test('expired recovery still requires exact historical signatures, keys, audience, time and pins', async (t) => {
  const fixture = qualificationFixture();
  const other = qualificationFixture();
  const dirs = await directories(t);
  fixture.advance('2030-01-01T00:01:00.000Z');
  const options = adapterOptions(dirs, fixture);
  const badSignature = `${fixture.trust.signature[0] === 'A' ? 'B' : 'A'}${fixture.trust.signature.slice(1)}`;
  for (const changes of [
    { qualificationTrust: { ...fixture.trust, signature: badSignature } },
    { qualificationTrustVerifier: other.verifier },
    { externalQualificationObservationVerifier: other.observer },
    { externalQualificationObservationVerifier: createE2BExternalQualificationObservationVerifier({
      ...fixture.observerOptions, audience: { ...fixture.observerOptions.audience, run_ref_hash: hash('other-run') } }) },
    { externalQualificationObservationVerifier: createE2BExternalQualificationObservationVerifier({
      ...fixture.observerOptions, maxReceiptAgeMs: 1_000 }) },
    { trustedRunnerArtifactHash: hash('other-runner') },
    { qualificationEvidence: { ...fixture.evidence, evidence_hash: hash('tampered') } },
  ]) assert.throws(() => new E2BRiskForkAdapter({ ...options, ...changes }));
  fixture.advance('2030-01-01T00:00:00.000Z');
  assert.throws(() => new E2BRiskForkAdapter(options), /future-issued/);
});

test('current-at-construction adapter latches observed expiry against clock rollback', async (t) => {
  const fixture = qualificationFixture();
  const dirs = await directories(t);
  const adapter = new E2BRiskForkAdapter(adapterOptions(dirs, fixture));
  assert.equal(adapter.qualificationEligible, true);
  fixture.advance('2030-01-01T00:01:00.000Z');
  await assert.rejects(adapter.createSavepoint({}), /expired/);
  assert.equal(adapter.qualificationEligible, false);
  fixture.advance(NOW);
  adapter.qualificationEligible = true;
  await assert.rejects(adapter.createSavepoint({}), /cleanup-only/);
  assert.deepEqual(await adapter.reconcilePendingCleanup(), { reconciled: [], unresolved: [] });
});

test('cleanup-first expiry observation cannot restore effect authority after clock rollback', async (t) => {
  const fixture = qualificationFixture();
  const dirs = await directories(t);
  const { record } = await intent(dirs);
  const adapter = new E2BRiskForkAdapter(adapterOptions(dirs, fixture));
  assert.equal(adapter.qualificationEligible, true);
  fixture.advance('2030-01-01T00:01:00.000Z');
  assert.deepEqual(await adapter.reconcilePendingCleanup(), { reconciled: [record.record_id], unresolved: [] });
  assert.equal(adapter.qualificationEligible, false);
  assert.equal(adapter.qualified, false);
  fixture.advance(NOW);
  adapter.qualificationEligible = true;
  adapter.qualified = true;
  await assert.rejects(adapter.createSavepoint({}), /cleanup-only/);
});

test('source-disabled provider obligations stay unresolved while local-only recovery needs no SDK', async (t) => {
  const dirs = await directories(t);
  const { journal, record } = await intent(dirs);
  const adapter = new E2BRiskForkAdapter(adapterOptions(dirs));
  assert.deepEqual(await adapter.reconcilePendingCleanup(), { reconciled: [record.record_id], unresolved: [] });
  const dirs2 = await directories(t);
  const pending = await intent(dirs2);
  await pending.journal.markAllocationRequested(pending.record.record_id);
  await pending.journal.markSandboxAllocated(pending.record.record_id, 'synthetic-sandbox');
  const fenced = new E2BRiskForkAdapter(adapterOptions(dirs2));
  let lookalikeCalls = 0;
  // This proves public properties cannot replace the private captured fence;
  // it is not a spy on the actual private SDK loader.
  fenced.sdkLoader = async () => { lookalikeCalls += 1; throw new Error('must not load'); };
  const result = await fenced.reconcilePendingCleanup();
  assert.deepEqual(result, { reconciled: [], unresolved: [pending.record.record_id] });
  assert.equal(lookalikeCalls, 0);
  assert.equal((await pending.journal.get(pending.record.record_id)).sandbox_absence_verified, false);
});

test('known sandbox cleanup rejects foreign journal and provider bindings before kill', async (t) => {
  const cases = [
    ['provider', { provider_id: 'foreign-provider' }, null, 0],
    ['journal-template', { template_id_hash: hash('foreign-template') }, null, 0],
    ['provider-template', {}, { templateId: 'foreign-template' }, 1],
    ['provider-id', {}, { sandboxId: 'foreign-sandbox' }, 1],
    ['metadata', {}, { metadata: { foreign: 'metadata' } }, 1],
    ['unavailable', {}, 'unavailable', 1],
    ['already-absent', {}, 'absent', 3],
    ['ambiguous-absence', {}, 'ambiguous', 2],
    ['journal-write-failed', {}, {}, 1],
    ['absence-write-failed', {}, {}, 3],
    ['journal-id-drift', {}, {}, 1],
    ['exact-binding', {}, {}, 3],
  ];
  for (const [name, journalChanges, infoChanges, expectedInfoCalls] of cases) {
    await t.test(name, async (t) => {
      const dirs = await directories(t);
      const { journal, record, metadata } = await intent(dirs, journalChanges);
      await journal.markExportVerifiedAbsent(record.record_id);
      await journal.markAllocationRequested(record.record_id, hash(metadata));
      await journal.markSandboxAllocated(record.record_id, 'synthetic-sandbox');
      let killed = false;
      let kills = 0;
      let infos = 0;
      class Sandbox {
        static async create() { throw new Error('must not allocate'); }
        static async getInfo(id) {
          infos += 1;
          assert.equal(id, 'synthetic-sandbox');
          if (infoChanges === 'unavailable') throw new Error('provider unavailable');
          if (infoChanges === 'absent' || (infoChanges === 'ambiguous' && infos === 1)) {
            const error = new Error('not found'); error.status = 404; throw error;
          }
          if (infoChanges === 'ambiguous') throw new Error('provider unavailable');
          if (name === 'journal-id-drift' && infos === 1) {
            await journal.markSandboxAllocated(record.record_id, 'foreign-sandbox');
          }
          if (killed) { const error = new Error('not found'); error.status = 404; throw error; }
          return { sandboxId: id, templateId: TEMPLATE, metadata, ...infoChanges };
        }
        static async kill(id) { assert.equal(id, 'synthetic-sandbox'); kills += 1; killed = true; }
        static list() {
          let delivered = false;
          return { get hasNext() { return !delivered; }, async nextItems() { delivered = true; return []; } };
        }
      }
      const adapter = new E2BRiskForkAdapter({ ...adapterOptions(dirs), SandboxClass: Sandbox, offlineConformance: true });
      const requestWrite = adapter.cleanupJournal.markSandboxCleanupRequested.bind(adapter.cleanupJournal);
      const absenceWrite = adapter.cleanupJournal.markSandboxVerifiedAbsent.bind(adapter.cleanupJournal);
      if (name === 'journal-write-failed') adapter.cleanupJournal.markSandboxCleanupRequested = async () => {
        throw new Error('injected durable cleanup intent failure');
      };
      if (name === 'absence-write-failed') adapter.cleanupJournal.markSandboxVerifiedAbsent = async () => {
        throw new Error('injected durable absence outcome failure');
      };
      const result = await adapter.reconcilePendingCleanup();
      const success = name === 'exact-binding' || name === 'already-absent';
      assert.equal(kills, name === 'exact-binding' || name === 'absence-write-failed' ? 1 : 0);
      assert.equal(infos, expectedInfoCalls);
      assert.deepEqual(result, { reconciled: success ? [record.record_id] : [], unresolved: success ? [] : [record.record_id] });
      assert.equal((await journal.get(record.record_id)).sandbox_absence_verified, success);
      if (name === 'journal-write-failed' || name === 'absence-write-failed') {
        adapter.cleanupJournal.markSandboxCleanupRequested = requestWrite;
        adapter.cleanupJournal.markSandboxVerifiedAbsent = absenceWrite;
        assert.deepEqual(await adapter.reconcilePendingCleanup(), { reconciled: [record.record_id], unresolved: [] });
        assert.equal(kills, 1, 'retry must converge without a duplicate kill after verified absence');
      }
    });
  }
});

test('destroyFork reports pre-existing absence without claiming a kill', async (t) => {
  const dirs = await directories(t);
  const { journal, record } = await intent(dirs);
  await journal.markExportVerifiedAbsent(record.record_id);
  await journal.markAllocationRequested(record.record_id);
  await journal.markSandboxAllocated(record.record_id, 'synthetic-sandbox');
  let kills = 0;
  class Sandbox {
    static async create() { throw new Error('must not allocate'); }
    static async getInfo() { const error = new Error('not found'); error.status = 404; throw error; }
    static async kill() { kills += 1; }
    static list() {
      let delivered = false;
      return { get hasNext() { return !delivered; }, async nextItems() { delivered = true; return []; } };
    }
  }
  const adapter = new E2BRiskForkAdapter({ ...adapterOptions(dirs), SandboxClass: Sandbox, offlineConformance: true });
  adapter.forks.set('synthetic-fork', { ref: 'synthetic-fork', record_id: record.record_id,
    sandbox_id: 'synthetic-sandbox', destroyed_verified: false });
  const result = await adapter.destroyFork({ fork_ref: 'synthetic-fork' });
  assert.equal(result.status, 'already_destroyed_verified');
  assert.equal(result.evidence_status, 'verified');
  assert.equal(kills, 0);
  assert.equal((await journal.get(record.record_id)).sandbox_absence_verified, true);
});
