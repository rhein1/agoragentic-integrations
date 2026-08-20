import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { E2BCleanupJournal } from '../src/adapters/e2b-cleanup-journal.mjs';
import { E2BRiskForkAdapter } from '../src/adapters/e2b.mjs';
import { hash, NOW } from './helpers.mjs';

const TEMPLATE_ID = 'template-risk-fork-clean-immutable-v1';

function reconciliationAdapter({ directory, exportsDirectory, SandboxClass }) {
  return new E2BRiskForkAdapter({
    SandboxClass,
    cleanTemplateId: TEMPLATE_ID,
    cleanTemplateHash: hash(TEMPLATE_ID),
    workspaceExportDirectory: exportsDirectory,
    cleanupJournalDirectory: directory,
    verifyAuthorityFreeSource: async () => {
      throw new Error('source verification is not used during cleanup reconciliation');
    },
    trustedBootstrapArtifactHash: hash('trusted-bootstrap'),
    trustedRunnerArtifactHash: hash('trusted-runner'),
    clock: () => new Date(NOW),
  });
}

test('cleanup journal persists allocation intent before provider identity and survives restart', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-journal-test-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const clock = () => new Date(NOW);
  const first = new E2BCleanupJournal({ directory, clock });
  await first.initialize();
  const created = await first.createIntent({
    record_id: 'cleanup_record_1',
    cleanup_ref: 'cleanup_ref_1',
    provider_id: 'e2b-clean-template-v1',
    template_id_hash: hash('template'),
    metadata_hash: hash('metadata'),
    export_id: 'export_1',
  });
  assert.equal(created.sandbox_state, 'not_requested');
  await first.markAllocationRequested(created.record_id);

  const restarted = new E2BCleanupJournal({ directory, clock });
  await restarted.initialize();
  const [pending] = await restarted.listPending();
  assert.equal(pending.record_id, created.record_id);
  assert.equal(pending.cleanup_ref, 'cleanup_ref_1');
  assert.equal(pending.sandbox_id, null);
  assert.equal(pending.sandbox_state, 'allocation_requested');
});

test('cleanup journal never rounds unknown cleanup up to verified absence', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-journal-unknown-'));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  const journal = new E2BCleanupJournal({ directory, clock: () => new Date(NOW) });
  await journal.initialize();
  const created = await journal.createIntent({
    record_id: 'cleanup_record_2',
    cleanup_ref: 'cleanup_ref_2',
    provider_id: 'e2b-clean-template-v1',
    template_id_hash: hash('template'),
    metadata_hash: hash('metadata'),
    export_id: 'export_2',
  });
  await journal.markAllocationRequested(created.record_id);
  await journal.markSandboxUnknown(created.record_id, 'PROVIDER_UNAVAILABLE');
  const record = await journal.get(created.record_id);
  assert.equal(record.sandbox_state, 'unknown');
  assert.equal(record.sandbox_absence_verified, false);
  assert.equal((await journal.listPending()).length, 1);
});

test('restart reconciliation discovers an exact metadata-bound orphan, kills it, and verifies absence', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-orphan-reconcile-'));
  const directory = path.join(root, 'journal');
  const exportsDirectory = path.join(root, 'exports');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cleanupRef = 'cleanup_ref_orphan_1';
  const metadata = {
    'agoragentic.risk_fork.profile': 'agoragentic.risk-fork.e2b-clean-template.v1',
    'agoragentic.risk_fork.cleanup_ref': cleanupRef,
  };
  const journal = new E2BCleanupJournal({ directory, clock: () => new Date(NOW) });
  const record = await journal.createIntent({
    record_id: 'cleanup_record_orphan_1',
    cleanup_ref: cleanupRef,
    provider_id: 'e2b-clean-template-v1',
    template_id_hash: hash(TEMPLATE_ID),
    metadata_hash: hash(metadata),
    export_id: 'export_orphan_1',
  });
  await journal.markExportVerifiedAbsent(record.record_id);
  await journal.markAllocationRequested(record.record_id, hash(metadata));
  let killed = false;
  const orphan = { sandboxId: 'sandbox-orphan-1', templateId: TEMPLATE_ID, metadata };
  class Sandbox {
    static async create() { throw new Error('allocation is forbidden during reconciliation'); }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
          delivered = true;
          return [orphan];
        },
      };
    }
    static async kill(id) {
      assert.equal(id, orphan.sandboxId);
      killed = true;
    }
    static async getInfo(id) {
      assert.equal(id, orphan.sandboxId);
      if (!killed) return orphan;
      const error = new Error('not found');
      error.status = 404;
      throw error;
    }
  }
  const adapter = reconciliationAdapter({ directory, exportsDirectory, SandboxClass: Sandbox });
  const result = await adapter.reconcilePendingCleanup();
  assert.deepEqual(result.unresolved, []);
  assert.deepEqual(result.reconciled, [record.record_id]);
  assert.equal(killed, true);
  const finalRecord = await journal.get(record.record_id);
  assert.equal(finalRecord.sandbox_state, 'verified_absent');
  assert.equal(finalRecord.sandbox_absence_verified, true);
});

test('restart reconciliation leaves an unbound allocation unknown and blocks false destruction', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-e2b-orphan-unknown-'));
  const directory = path.join(root, 'journal');
  const exportsDirectory = path.join(root, 'exports');
  t.after(async () => rm(root, { recursive: true, force: true }));
  const cleanupRef = 'cleanup_ref_orphan_2';
  const expectedMetadata = {
    'agoragentic.risk_fork.profile': 'agoragentic.risk-fork.e2b-clean-template.v1',
    'agoragentic.risk_fork.cleanup_ref': cleanupRef,
  };
  const journal = new E2BCleanupJournal({ directory, clock: () => new Date(NOW) });
  const record = await journal.createIntent({
    record_id: 'cleanup_record_orphan_2',
    cleanup_ref: cleanupRef,
    provider_id: 'e2b-clean-template-v1',
    template_id_hash: hash(TEMPLATE_ID),
    metadata_hash: hash(expectedMetadata),
    export_id: 'export_orphan_2',
  });
  await journal.markExportVerifiedAbsent(record.record_id);
  await journal.markAllocationRequested(record.record_id, hash(expectedMetadata));
  let killCalls = 0;
  class Sandbox {
    static async create() { throw new Error('allocation is forbidden during reconciliation'); }
    static list() {
      let delivered = false;
      return {
        get hasNext() { return !delivered; },
        async nextItems() {
          delivered = true;
          return [{
            sandboxId: 'sandbox-unbound',
            templateId: TEMPLATE_ID,
            metadata: { ...expectedMetadata, substituted: 'not-the-journal-binding' },
          }];
        },
      };
    }
    static async kill() { killCalls += 1; }
    static async getInfo() { throw new Error('must not inspect an unbound sandbox'); }
  }
  const adapter = reconciliationAdapter({ directory, exportsDirectory, SandboxClass: Sandbox });
  const result = await adapter.reconcilePendingCleanup();
  assert.deepEqual(result.reconciled, []);
  assert.deepEqual(result.unresolved, [record.record_id]);
  assert.equal(killCalls, 0);
  const finalRecord = await journal.get(record.record_id);
  assert.equal(finalRecord.sandbox_state, 'unknown');
  assert.equal(finalRecord.sandbox_absence_verified, false);

  const restarted = reconciliationAdapter({ directory, exportsDirectory, SandboxClass: Sandbox });
  await assert.rejects(
    restarted.createFork({}),
    (error) => error?.code === 'E2B_CLEANUP_RECONCILIATION_REQUIRED'
      && error?.unresolved_count === 1,
    'adapter initialization must not permit allocation while durable cleanup is unresolved',
  );
  assert.equal(killCalls, 0);
});
