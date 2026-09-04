import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPRESENTATIVE_SCENARIOS,
  runOfflineRuntimeVerification,
} from '../src/offline-runtime-verifier.mjs';

test('offline runtime verifier exercises decision, lifecycle, receipt, recorder, and cleanup paths', async () => {
  const result = await runOfflineRuntimeVerification();
  assert.equal(result.verified, true);
  assert.equal(result.absolute_path_redacted, true);
  assert.deepEqual(result.representative_scenarios, [...REPRESENTATIVE_SCENARIOS]);
  assert.equal(result.results.length, 8);
  assert.equal(result.results.find((item) => item.scenario_id === 'high-filesystem-write').final_state, 'prepared_not_committed');
  assert.equal(result.results.find((item) => item.scenario_id === 'irreversible-deployment-proposal').final_state, 'prepared_not_committed');
  assert.equal(result.results.find((item) => item.scenario_id === 'e2b-malicious-mcp-containment').final_state, 'prepared_not_committed');
  for (const id of ['cleanup-unknown', 'malformed-lifecycle-receipt', 'attack-secret']) {
    assert.notEqual(result.results.find((item) => item.scenario_id === id).exit_code, 0);
  }
  assert.equal(result.recorder.mode, 'REPLAY');
  assert.equal(result.recorder.loopback_transport_used, true);
  assert.equal(result.recorder.external_network_used, false);
  assert.equal(result.recorder.token_redacted, true);
  assert.equal(result.recorder.receipt_hash_verified_visible, true);
  assert.equal(result.recorder.receipt_binding_verified_visible, true);
  assert.equal(result.recorder.classifier_version_visible, true);
  assert.equal(result.recorder.all_demo_limits_visible, true);
  assert.equal(result.recorder.bounded_tainted_output_evidence_visible, true);
  assert.equal(result.cleanup.status, 'verified');
});
