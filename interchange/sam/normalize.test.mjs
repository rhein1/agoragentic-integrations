import assert from 'node:assert/strict';
import test from 'node:test';

import { hashRef, normalizeSamTool, parseSamToolName } from './normalize.mjs';

const PEER_ID = '12D3KooWQJYx8zW9fYh5Qb6uN7mP4rT2sV1cA9eD8gF7hJ6kL5mN';
const TOOL_NAME = 'mcp://code-reviewer/review_code';

function fixture() {
  return {
    discovery: {
      peer_id: PEER_ID,
      tool_name: TOOL_NAME,
      description: 'Review a code snippet.',
      labels: { team: 'platform', region: 'us-east-1' },
    },
    description: {
      peer_id: PEER_ID,
      tool_name: TOOL_NAME,
      description: 'Review a code snippet.',
      input_schema: {
        type: 'object',
        required: ['code'],
        properties: { code: { type: 'string' } },
      },
    },
  };
}

test('normalizes a SAM tool without leaking the raw transport target', () => {
  const packet = normalizeSamTool({ ...fixture(), observedAt: '2026-08-19T20:00:00.000Z' });
  const serialized = JSON.stringify(packet);

  assert.equal(packet.schema, 'agoragentic.interchange.sam-tool-import.v1');
  assert.equal(packet.source_kind, 'sam_mesh_tool');
  assert.equal(packet.eligibility.eligible, false);
  assert.equal(packet.authority_flags.payment_enabled, false);
  assert.equal(packet.authority_flags.public_execute_enabled, false);
  assert.equal(packet.transport_evidence.authorization_verified_by_normalizer, false);
  assert.deepEqual(packet.transport_evidence.observed_label_keys, ['region', 'team']);
  assert.equal(packet.private_transport_target, undefined);
  assert.equal(serialized.includes(PEER_ID), false);
  assert.equal(serialized.includes(TOOL_NAME), false);
  assert.equal(serialized.includes('code-reviewer'), false);
  assert.equal(serialized.includes('review_code'), false);
  assert.equal(serialized.includes('Review a code snippet.'), false);
  assert.match(packet.capability_card_input.name, /^SAM MCP tool [a-f0-9]{12}$/);
  assert.match(packet.transport_evidence.peer_ref, /^sha256:[a-f0-9]{64}$/);
});

test('includes the private target only after explicit opt-in', () => {
  const packet = normalizeSamTool({ ...fixture(), includePrivateTarget: true });
  assert.equal(packet.private_transport_target.peer_id, PEER_ID);
  assert.equal(packet.private_transport_target.tool_name, TOOL_NAME);
  assert.deepEqual(packet.private_transport_target.observed_labels, {
    region: 'us-east-1',
    team: 'platform',
  });
});

test('rejects a description for a different peer or tool', () => {
  const peerMismatch = fixture();
  peerMismatch.description.peer_id = '12D3KooWDifferent';
  assert.throws(() => normalizeSamTool(peerMismatch), /sam_description_peer_mismatch/);

  const toolMismatch = fixture();
  toolMismatch.description.tool_name = 'mcp://code-reviewer/other_tool';
  assert.throws(() => normalizeSamTool(toolMismatch), /sam_description_tool_mismatch/);
});

test('rejects system, malformed, and errored discovery rows', () => {
  assert.throws(() => parseSamToolName('system://sam.catalog/list_local_services'), /mcp_namespace/);
  assert.throws(() => parseSamToolName('mcp://missing-tool'), /service_slash_tool/);
  assert.throws(() => parseSamToolName('mcp://service/tool?admin=true'), /service_slash_tool/);
  assert.throws(() => parseSamToolName('mcp://service/tool#private'), /service_slash_tool/);
  assert.throws(() => parseSamToolName('mcp://user@service/tool'), /service_slash_tool/);

  const errored = fixture();
  errored.discovery.error = 'failed to connect';
  assert.throws(() => normalizeSamTool(errored), /contains_error/);
});

test('hashRef is deterministic across object key order', () => {
  assert.equal(hashRef({ b: 2, a: 1 }), hashRef({ a: 1, b: 2 }));
});

test('hashRef preserves own __proto__ properties from parsed JSON', () => {
  const withProto = JSON.parse('{"schema":{"type":"object","__proto__":{"const":"bound"}}}');
  const withoutProto = JSON.parse('{"schema":{"type":"object"}}');
  assert.notEqual(hashRef(withProto), hashRef(withoutProto));
});

test('rejects error-bearing or schema-less describe results', () => {
  const errored = fixture();
  errored.description.error = 'authorization denied';
  delete errored.description.input_schema;
  assert.throws(() => normalizeSamTool(errored), /sam_description_contains_error/);

  const schemaLess = fixture();
  delete schemaLess.description.input_schema;
  assert.throws(() => normalizeSamTool(schemaLess), /sam_description_input_schema_required/);
});

test('rejects unbounded or malformed remote metadata', () => {
  const oversizedDescription = fixture();
  oversizedDescription.description.description = 'x'.repeat(8_193);
  assert.throws(() => normalizeSamTool(oversizedDescription), /sam_tool_description_too_long/);

  const oversizedTool = fixture();
  oversizedTool.discovery.tool_name = `mcp://service/${'x'.repeat(512)}`;
  oversizedTool.description.tool_name = oversizedTool.discovery.tool_name;
  assert.throws(() => normalizeSamTool(oversizedTool), /sam_tool_name_too_long/);

  assert.throws(
    () => normalizeSamTool({ ...fixture(), observedAt: 'not-a-timestamp' }),
    /sam_observed_at_invalid/,
  );
  assert.throws(
    () => normalizeSamTool({ ...fixture(), observedAt: '2026-02-30T00:00:00Z' }),
    /sam_observed_at_invalid/,
  );
  assert.throws(
    () => normalizeSamTool({ ...fixture(), observedAt: '2025-02-29T00:00:00Z' }),
    /sam_observed_at_invalid/,
  );
  assert.doesNotThrow(
    () => normalizeSamTool({ ...fixture(), observedAt: '2024-02-29T23:59:59.123+05:30' }),
  );
});
