import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import * as taintGate from '../src/taint-gate.mjs';
import { createMcpTransportResultSchema } from '../src/mcp-transport-contract.mjs';
import { NOW, hash } from './helpers.mjs';

const MCP_STRUCTURED_CONTENT_FIXTURE = JSON.parse(await readFile(
  new URL('../schema/fixtures/mcp-2026-07-28-structured-content.json', import.meta.url),
  'utf8',
));

const WORKSPACE_POLICY = Object.freeze({
  path_allowlist: ['src'],
  allow_delete: false,
  required_tests: [],
  max_files: 10,
  max_diff_bytes: 10_000,
});

function workspaceArtifact({ files = [], testEvidence = [], policy = WORKSPACE_POLICY } = {}) {
  return taintGate.validateCommitCandidate({
    candidate: {
      type: 'WORKSPACE_DIFF',
      files,
      test_evidence: testEvidence,
    },
    source_fork_id: 'fork:taint-policy-separation',
    policy,
    validated_at: NOW,
  });
}

function typedArtifact(
  payload,
  payloadSchema,
  sourceForkId = 'fork:taint-policy-separation',
) {
  return taintGate.validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload,
      payload_schema: payloadSchema,
    },
    source_fork_id: sourceForkId,
    validated_at: NOW,
  });
}

function closedStringPayloadSchema(keys) {
  return {
    type: 'object',
    additionalProperties: false,
    required: keys,
    properties: Object.fromEntries(keys.map((key) => [key, { type: 'string' }])),
  };
}

function closedStructuredContentSchema(structuredContentSchema, dialect) {
  return {
    ...(dialect === undefined ? {} : { $schema: dialect }),
    type: 'object',
    additionalProperties: false,
    required: ['structuredContent'],
    properties: {
      structuredContent: structuredContentSchema,
    },
  };
}

function mcpTransportPayload(mcpResult) {
  const digest = hash('mcp-transport-local-ref');
  return {
    schema: 'agoragentic.risk-fork.mcp-transport-result.v2',
    transport_evidence: {
      schema: 'agoragentic.risk-fork.mcp-transport-evidence.v2',
      destination_policy_hash: digest,
      requested_url: 'https://mcp.public-example.net/rpc',
      final_url: 'https://mcp.public-example.net/rpc',
      redirect_count: 0,
      dns_name: 'mcp.public-example.net',
      cname_chain: ['mcp.public-example.net'],
      resolved_addresses: ['104.18.6.229'],
      selected_address: '104.18.6.229',
      tls_authorized: true,
      tls_server_name: 'mcp.public-example.net',
      http_host: 'mcp.public-example.net',
      proxy_used: false,
      request_body_hash: digest,
      response_body_hash: digest,
      wire_result_hash: digest,
      wire_result_type: 'complete',
      wire_result_metadata: {
        schema: 'agoragentic.risk-fork.mcp-wire-metadata-evidence.v1',
        result_type: 'complete',
        cacheable_result: false,
        ttl_ms: null,
        cache_scope: null,
        result_meta_hash: null,
        metadata_hash: digest,
      },
      measurements: {
        dns_query_count: 3,
        connection_attempt_count: 1,
        http_request_count: 1,
        retry_count: 0,
        request_body_bytes: 1,
        response_body_bytes: 1,
        elapsed_ms: 0,
        http_status_code: 200,
        tls_protocol: 'TLSv1.3',
        response_content_type: 'application/json',
        response_content_encoding: null,
        decompression_used: false,
        sse_used: false,
        sse_event_count: 0,
        sse_notification_count: 0,
        protocol_metadata_sent: true,
        method_header_sent: true,
        name_header_sent: false,
        parameter_header_count: 0,
        access_header_sent: false,
        cookie_header_sent: false,
        state_header_sent: false,
        response_cookie_received: false,
        response_state_created: false,
        access_challenge_received: false,
      },
      evidence_hash: digest,
    },
    mcp_result: mcpResult,
  };
}

test('typed results use JSON Schema 2020-12 by default and preserve explicit draft-07', () => {
  const fixture = MCP_STRUCTURED_CONTENT_FIXTURE;
  assert.equal(fixture.protocol_version, '2026-07-28');
  assert.equal(fixture.schema_dialect, 'https://json-schema.org/draft/2020-12/schema');
  assert.deepEqual(
    fixture.allowed_json_values.map((value) => (
      value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    )),
    ['array', 'string', 'number', 'boolean', 'null'],
  );

  for (const dialect of [fixture.schema_dialect, undefined]) {
    const schema = closedStructuredContentSchema(fixture.prefix_items.schema, dialect);
    const artifact = typedArtifact(
      { structuredContent: fixture.prefix_items.valid_value },
      schema,
    );
    assert.deepEqual(
      artifact.body.payload.structuredContent,
      fixture.prefix_items.valid_value,
    );
    assert.throws(
      () => typedArtifact(
        { structuredContent: fixture.prefix_items.invalid_value },
        schema,
      ),
      /does not satisfy its schema/i,
    );
  }

  const draft07Schema = closedStructuredContentSchema({
    type: 'array',
    items: [
      { const: 'legacy' },
      { type: 'integer' },
    ],
    additionalItems: false,
    minItems: 2,
  }, 'http://json-schema.org/draft-07/schema#');
  assert.deepEqual(
    typedArtifact({ structuredContent: ['legacy', 7] }, draft07Schema)
      .body.payload.structuredContent,
    ['legacy', 7],
  );

  assert.throws(
    () => typedArtifact(
      { structuredContent: 'unsupported-dialect' },
      closedStructuredContentSchema(true, 'https://example.invalid/schema'),
    ),
    /unsupported JSON Schema dialect/i,
  );
});

test('MCP transport envelopes propagate the result dialect before taint validation', () => {
  const schemas = [
    [
      'https://json-schema.org/draft/2020-12/schema',
      { type: 'object', additionalProperties: false, properties: {} },
    ],
    [
      'http://json-schema.org/draft-07/schema#',
      {
        $schema: 'http://json-schema.org/draft-07/schema#',
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    ],
  ];
  for (const [dialect, mcpResultSchema] of schemas) {
    const transportSchema = createMcpTransportResultSchema(mcpResultSchema);
    assert.equal(transportSchema.$schema, dialect);
    assert.throws(
      () => typedArtifact({}, transportSchema),
      /does not satisfy its schema/i,
      dialect,
    );
  }
  assert.throws(
    () => createMcpTransportResultSchema({
      $schema: 'https://example.invalid/schema',
      type: 'object',
    }),
    /unsupported JSON Schema dialect/i,
  );
});

test('MCP transport envelopes preserve local result-schema references', () => {
  const cases = [
    {
      schema: {
        $defs: { value: { type: 'string' } },
        $ref: '#/$defs/value',
      },
      accepted: 'modern',
      rejected: 7,
    },
    {
      schema: {
        $schema: 'http://json-schema.org/draft-07/schema#',
        definitions: { value: { type: 'integer' } },
        $ref: '#/definitions/value',
      },
      accepted: 7,
      rejected: 'legacy',
    },
    {
      schema: {
        $defs: { value: { $anchor: 'value', type: 'string' } },
        $ref: '#value',
      },
      accepted: 'anchored',
      rejected: false,
    },
  ];
  for (const item of cases) {
    const transportSchema = createMcpTransportResultSchema(item.schema);
    assert.match(
      transportSchema.properties.mcp_result.$id,
      /^https:\/\/agoragentic\.com\/schema\/risk-fork-/,
    );
    assert.deepEqual(
      typedArtifact(mcpTransportPayload(item.accepted), transportSchema)
        .body.payload.mcp_result,
      item.accepted,
    );
    assert.throws(
      () => typedArtifact(mcpTransportPayload(item.rejected), transportSchema),
      /does not satisfy its schema/i,
    );
  }
});

test('schema resource discovery ignores instance-valued annotation and assertion data', () => {
  const schema = closedStructuredContentSchema({
    anyOf: [
      { const: { $id: 7, value: 'const' } },
      { enum: [{ $id: 'instance-data', value: 'enum' }] },
      {
        type: 'string',
        default: { $id: 8, value: 'default-annotation' },
        examples: [{ $id: 9, value: 'example-annotation' }],
      },
    ],
  });
  for (const structuredContent of [
    { $id: 7, value: 'const' },
    { $id: 'instance-data', value: 'enum' },
    'ordinary-string',
  ]) {
    assert.deepEqual(
      typedArtifact({ structuredContent }, schema).body.payload.structuredContent,
      structuredContent,
    );
  }
});

test('MCP structuredContent accepts arrays and primitive JSON values in the closed envelope', () => {
  const schema = closedStructuredContentSchema(
    true,
    MCP_STRUCTURED_CONTENT_FIXTURE.schema_dialect,
  );
  for (const structuredContent of MCP_STRUCTURED_CONTENT_FIXTURE.allowed_json_values) {
    const artifact = typedArtifact({ structuredContent }, schema);
    assert.deepEqual(artifact.body.payload.structuredContent, structuredContent);
  }
});

test('exact generated amk_ material is rejected even when embedded', () => {
  const syntheticKey = `amk_${'a'.repeat(64)}`;

  assert.throws(
    () => typedArtifact(
      { note: `opaque child output x${syntheticKey}y` },
      closedStringPayloadSchema(['note']),
    ),
    /taint scan failed: secret_pattern/i,
  );
  assert.throws(
    () => workspaceArtifact({
      files: [{
        path: 'src/child-output.txt',
        operation: 'create',
        before_hash: null,
        after_content: `opaque child output _${syntheticKey}-`,
      }],
    }),
    /workspace diff taint scan failed/i,
  );
});

test('documented amk_ placeholders remain non-authority text', () => {
  for (const placeholder of [
    'amk_your_key',
    'amk_your_key_here',
    'amk_your_api_key_here',
  ]) {
    const artifact = typedArtifact(
      { note: `documentation example: ${placeholder}` },
      closedStringPayloadSchema(['note']),
    );
    assert.equal(artifact.body.payload.note, `documentation example: ${placeholder}`);
  }
});

test('generic credential prefixes accept underscore or dash separators', () => {
  for (const token of [
    `sk_${'s'.repeat(20)}`,
    `sk-${'s'.repeat(20)}`,
    `ghp_${'g'.repeat(20)}`,
    `gho_${'g'.repeat(20)}`,
    `ghu_${'g'.repeat(20)}`,
    `ghs_${'g'.repeat(20)}`,
    `ghr_${'g'.repeat(20)}`,
    `github_pat_${'g'.repeat(20)}`,
    `xoxb_${'x'.repeat(20)}`,
    `xoxb-${'x'.repeat(20)}`,
  ]) {
    assert.throws(
      () => typedArtifact(
        { note: `opaque child output ${token}` },
        closedStringPayloadSchema(['note']),
      ),
      /taint scan failed: secret_pattern/i,
      token.slice(0, token.indexOf(token.includes('_') ? '_' : '-') + 1),
    );
  }
});

test('secret-shaped object keys, schema metadata, and workspace paths are rejected without echo', () => {
  const syntheticKey = `amk_${'b'.repeat(64)}`;
  const embedded = `x${syntheticKey}y`;

  for (const invoke of [
    () => typedArtifact(
      { [embedded]: 'opaque-child-value' },
      closedStringPayloadSchema([embedded]),
    ),
    () => typedArtifact(
      { note: 'opaque-child-value' },
      {
        ...closedStringPayloadSchema(['note']),
        description: `schema metadata ${embedded}`,
      },
    ),
    () => workspaceArtifact({
      files: [{
        path: `src/${embedded}.txt`,
        operation: 'create',
        before_hash: null,
        after_content: 'opaque-child-value',
      }],
    }),
  ]) {
    assert.throws(invoke, (error) => {
      assert.match(error.message, /taint scan failed/i);
      assert.equal(error.message.includes(syntheticKey), false);
      return true;
    });
  }
});

test('unsupported envelope and file keys are rejected without echoing credentials', () => {
  const syntheticKey = `amk_${'d'.repeat(64)}`;
  const embedded = `x${syntheticKey}y`;
  for (const invoke of [
    () => taintGate.validateCommitCandidate({
      candidate: {
        type: 'TYPED_RESULT',
        payload: { note: 'opaque-child-value' },
        payload_schema: closedStringPayloadSchema(['note']),
        [embedded]: 'unexpected',
      },
      source_fork_id: 'fork:taint-policy-separation',
      validated_at: NOW,
    }),
    () => workspaceArtifact({
      files: [{
        path: 'src/opaque.txt',
        operation: 'create',
        before_hash: null,
        after_content: 'opaque-child-value',
        [embedded]: 'unexpected',
      }],
    }),
  ]) {
    assert.throws(invoke, (error) => {
      assert.match(error.message, /unsupported secret-shaped field/i);
      assert.equal(error.message.includes(syntheticKey), false);
      return true;
    });
  }
});

test('authority and memory field names reject camelCase and separator variants', () => {
  const forbiddenKeys = [
    'authorizationGrant',
    'authorization-grant',
    'authorization.grant',
    'authorization grant',
    'authorization\uFF0Egrant',
    'privateKey',
    'private-key',
    'parentMemory',
    'parent\u00A0memory',
    'memoryUpdate',
    'AuThOrIzAtIoN',
    'mEsSaGeS',
    'walletPRIVATEKey',
    'rawCHILDConversation',
  ];

  for (const key of forbiddenKeys) {
    assert.throws(
      () => typedArtifact(
        { [key]: 'opaque-child-value' },
        closedStringPayloadSchema([key]),
      ),
      /cannot carry trusted authority or memory field/i,
      key,
    );
  }
});

test('source fork IDs share the schema secret-filtered opaque-reference boundary', () => {
  const syntheticKey = `amk_${'b'.repeat(64)}`;
  const payload = { note: 'opaque-child-value' };
  const payloadSchema = closedStringPayloadSchema(['note']);

  assert.throws(
    () => typedArtifact(payload, payloadSchema, `fork:${syntheticKey}`),
    /source_fork_id appears to contain secret material/i,
  );

  const forged = structuredClone(typedArtifact(payload, payloadSchema));
  forged.source_fork_id = `fork:${syntheticKey}`;
  forged.artifact_hash = hash({ ...forged, artifact_hash: null });
  assert.throws(
    () => taintGate.verifyCommitArtifact(forged),
    /commit artifact\.source_fork_id appears to contain secret material/i,
  );
});

test('authority-field normalization conservatively rejects bounded absence metadata', () => {
  const payload = {
    authorizationGrantStatus: 'absent',
    privateKeyScanStatus: 'passed',
    parentMemoryRedactionStatus: 'passed',
    memoryUpdatePolicy: 'deny',
  };
  assert.throws(
    () => typedArtifact(payload, closedStringPayloadSchema(Object.keys(payload))),
    /cannot carry trusted authority or memory field/i,
  );
});

test('public artifact verification does not invent an allowlist from child paths', () => {
  const artifact = workspaceArtifact({ files: [] });

  assert.equal(taintGate.verifyCommitArtifact(artifact), true);
});

test('public verification is structural while current deletion policy remains clean-side', () => {
  const artifact = workspaceArtifact({
    files: [{
      path: 'src/obsolete.txt',
      operation: 'delete',
      before_hash: hash('obsolete-content'),
      after_content: null,
    }],
    policy: { ...WORKSPACE_POLICY, allow_delete: true },
  });

  assert.equal(taintGate.verifyCommitArtifact(artifact), true);
  assert.throws(
    () => taintGate.revalidateCommitArtifact(artifact, { policy: WORKSPACE_POLICY }),
    /deletion.*not allowed|current commit policy/i,
  );
});

test('child-asserted passing evidence cannot satisfy a current required-test policy', () => {
  const testEvidence = [{
    name: 'unit:test',
    status: 'passed',
    evidence_ref: 'child-test:unit',
    evidence_hash: hash('child-test-unit'),
    duration_ms: 25,
  }];
  const policy = { ...WORKSPACE_POLICY, required_tests: ['unit:test'] };
  const artifact = workspaceArtifact({ testEvidence, policy });

  assert.throws(
    () => taintGate.revalidateCommitArtifact(artifact, { policy }),
    /clean-side required-test verification/i,
  );
});

test('clean-side required-test verification is exact-bound before policy revalidation', async () => {
  const testEvidence = [{
    name: 'unit:test',
    status: 'passed',
    evidence_ref: 'child-test:unit',
    evidence_hash: hash('child-test-unit'),
    duration_ms: 25,
  }];
  const policy = { ...WORKSPACE_POLICY, required_tests: ['unit:test'] };
  const artifact = workspaceArtifact({ testEvidence, policy });
  let requests = 0;

  assert.equal(typeof taintGate.verifyWorkspaceRequiredTests, 'function');
  await assert.rejects(
    taintGate.verifyWorkspaceRequiredTests(artifact, { policy, now: NOW }),
    /trusted clean-side required-test evidence verifier/i,
  );
  await assert.rejects(
    taintGate.verifyWorkspaceRequiredTests(artifact, {
      policy,
      now: NOW,
      verifyTestEvidence: async (request) => ({
        schema: 'agoragentic.risk-fork.required-test-attestation.v1',
        status: 'verified',
        request_hash: request.request_hash,
        test_name: request.test_name,
        artifact_hash: hash('wrong-artifact'),
        diff_hash: request.diff_hash,
        policy_hash: request.policy_hash,
        method: 'clean_reexecution',
        evidence_ref: 'clean-test:wrong-binding',
        evidence_hash: hash('clean-test-wrong-binding'),
      }),
    }),
    /binding mismatch: artifact_hash/,
  );
  const proof = await taintGate.verifyWorkspaceRequiredTests(artifact, {
    policy,
    now: NOW,
    verifyTestEvidence: async (request) => {
      requests += 1;
      assert.equal(request.authority_flags.child_evidence_is_authority, false);
      assert.equal(request.artifact_hash, artifact.artifact_hash);
      assert.equal(request.diff_hash, artifact.body.diff_hash);
      assert.equal(request.test_name, 'unit:test');
      assert.deepEqual(request.child_evidence_claims, testEvidence);
      return {
        schema: 'agoragentic.risk-fork.required-test-attestation.v1',
        status: 'verified',
        request_hash: request.request_hash,
        test_name: request.test_name,
        artifact_hash: request.artifact_hash,
        diff_hash: request.diff_hash,
        policy_hash: request.policy_hash,
        method: 'clean_reexecution',
        evidence_ref: 'clean-test:unit',
        evidence_hash: hash({ request_hash: request.request_hash, passed: true }),
      };
    },
  });

  assert.equal(requests, 1);
  assert.equal(proof.status, 'verified');
  assert.equal(
    taintGate.revalidateCommitArtifact(artifact, {
      policy,
      required_test_verification: proof,
      now: NOW,
    }),
    true,
  );

  const untrustedClone = structuredClone(proof);
  assert.throws(
    () => taintGate.revalidateCommitArtifact(artifact, {
      policy,
      required_test_verification: untrustedClone,
      now: NOW,
    }),
    /must originate from the clean-side verifier/i,
  );
});
