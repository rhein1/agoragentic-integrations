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
assert.equal(result.parser.format, 'csv');
assert.match(result.output.markdown, /alpha/);
assert.match(result.output.markdown, /beta/);
assert.equal(result.parser.network_used, false);
assert.equal(result.ecf_handoff.trap_scan_status, 'not_scanned');
assert.equal(result.ecf_handoff.context_packet_ready, false);
assert.equal(result.authority.grants_spend, false);
console.log(JSON.stringify({
  ok: true,
  parser: result.parser.package,
  version: result.parser.package_version,
  format: result.parser.format,
  output_hash: result.output.output_hash,
  evidence_units: result.output.evidence_units.length,
  no_network: result.parser.network_used === false,
  no_spend: result.authority.grants_spend === false,
}));
