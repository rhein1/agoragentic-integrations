import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runProof } from '../run.mjs';

test('governed research proof stays local, cited, reconciled, and no-spend', async () => {
  const outputDir = await mkdtemp(path.join(os.tmpdir(), 'agoragentic-governed-research-'));
  try {
    const result = await runProof({ outputDir });
    assert.equal(result.ok, true);
    assert.equal(result.quote.price_usdc, 0);
    assert.equal(result.quote.payment_required, false);
    assert.equal(result.receipt.cost_usdc, 0);
    assert.deepEqual(result.receipt.settlement, { network: 'none', status: 'not_applicable' });
    assert.equal(result.report.citations.length, 3);
    assert.equal(result.contextPacket.sources.length, 3);
    assert.equal(result.contextPacket.export_boundary.raw_content_exported, false);
    assert.equal(result.policySummary.budget.max_daily_spend_usdc, 0);
    assert.ok(result.policySummary.denied_tools.includes('marketplace_execute'));
    assert.equal(result.reconciliation.authority_boundary.network_access, false);
    assert.equal(result.reconciliation.authority_boundary.provider_execution, false);
    assert.equal(result.reconciliation.authority_boundary.wallet_access, false);
    assert.equal(result.reconciliation.authority_boundary.spend_enabled, false);
    assert.equal(result.reconciliation.checks.context_packet_matches_sources, true);

    for (const artifactPath of Object.values(result.artifacts)) {
      const artifact = JSON.parse(await readFile(artifactPath, 'utf8'));
      assert.ok(artifact.schema);
    }
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
