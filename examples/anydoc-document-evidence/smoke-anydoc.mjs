import assert from 'node:assert/strict';
import { convertBytesToEvidence } from './agoragentic-anydoc.mjs';

const result = await convertBytesToEvidence({
  bytes: Buffer.from('name,value\nalpha,1\nbeta,2\n', 'utf8'),
  filename: 'smoke.csv',
}, {
  inspectStructure: true,
  maxMarkdownChars: 100_000,
});

assert.equal(result.parser.package, '@firecrawl/anydoc');
assert.equal(result.parser.package_version, '0.1.7');
assert.equal(result.parser.provenance.attested, true);
assert.equal(result.parser.format, 'csv');
assert.match(result.output.markdown, /alpha/);
assert.match(result.output.markdown, /beta/);
assert.equal(result.parser.network.status, 'not_observed');
assert.equal(result.parser.network.verified_absent, false);
assert.equal(result.parser.network.attempted_node_api_calls, 0);
assert.equal(result.parser.execution, 'isolated_child_process');
assert.equal(result.parser.boundary.killable, true);
assert.equal(result.parser.boundary.network_policy, 'node_api_deny_guard');
assert.equal(result.output.evidence_coverage.complete, true);
assert.equal(result.output.completeness.complete, true);
assert.equal(result.ecf_handoff.trap_scan_status, 'not_scanned');
assert.equal(result.ecf_handoff.context_packet_ready, false);
assert.equal(result.ecf_handoff.receipt.status, 'pending');
assert.equal(result.authority.grants_spend, false);
console.log(JSON.stringify({
  ok: true,
  parser: result.parser.package,
  version: result.parser.package_version,
  format: result.parser.format,
  output_hash: result.output.output_hash,
  evidence_units: result.output.evidence_units.length,
  evidence_coverage_complete: result.output.evidence_coverage.complete,
  process_isolated: result.parser.boundary.process_isolated,
  node_network_attempts: result.parser.network.attempted_node_api_calls,
  network_absence_verified: result.parser.network.verified_absent,
  no_spend: result.authority.grants_spend === false,
}));
