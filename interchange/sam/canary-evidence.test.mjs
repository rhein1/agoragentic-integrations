import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const evidenceUrl = new URL('./evidence/readonly-canary-20260820.json', import.meta.url);
const provenanceUrl = new URL('./provenance.json', import.meta.url);

test('sanitized canary evidence preserves every default-off boundary', async () => {
  const evidenceText = await readFile(evidenceUrl, 'utf8');
  const evidence = JSON.parse(evidenceText);
  const provenance = JSON.parse(await readFile(provenanceUrl, 'utf8'));

  assert.equal(evidence.provenance.sam_runtime_revision, 'b42aaaf2d7f9ec450ab15e97bf704a21539de0e3');
  assert.equal(provenance.runtime_evidence.sam_runtime_revision, evidence.provenance.sam_runtime_revision);
  const canonicalEvidenceText = evidenceText.replace(/\r\n?/g, '\n');
  assert.equal(
    provenance.runtime_evidence.receipt_utf8_lf_sha256,
    createHash('sha256').update(canonicalEvidenceText).digest('hex'),
  );
  assert.equal(evidence.observation.authenticated_sidecar, true);
  assert.equal(evidence.observation.exact_peer_catalog_tool_count, 1);
  assert.deepEqual(evidence.observation.allowed_tool_calls, [
    'get_mesh_info',
    'discover_remote_services',
    'find_remote_tools',
    'find_remote_tools',
    'describe_remote_tool',
  ]);
  assert.equal(evidence.observation.call_remote_tool_used, false);
  assert.equal(evidence.observation.provider_tool_invoked, false);
  assert.equal(evidence.observation.funds_moved, false);
  assert.equal(evidence.operator_provider_binding.scope, 'ephemeral_local_canary_only');
  assert.equal(evidence.operator_provider_binding.production_provider_account_bound, false);
  assert.equal(evidence.normalized_packet.eligibility.eligible, false);
  assert.equal(Object.values(evidence.normalized_packet.authority_flags).some(Boolean), false);
  assert.equal(
    Object.entries(evidence.activation)
      .filter(([key]) => key !== 'readonly_canary_completed')
      .some(([, value]) => value === true),
    false,
  );
  assert.equal(JSON.stringify(evidence).includes('12D3KooW'), false);
  assert.equal(JSON.stringify(evidence).includes('mcp://agoragentic-canary/inspect_schema'), false);
});
