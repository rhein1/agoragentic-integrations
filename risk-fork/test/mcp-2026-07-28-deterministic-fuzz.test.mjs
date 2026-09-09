import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import { assertHostCanEnforce } from '../src/interception.mjs';
import { createLifecycle, transitionLifecycle, verifyLifecycle } from '../src/lifecycle.mjs';
import {
  RISK_FORK_MCP_PORTABLE_HANDLE_DIAGNOSTIC_CODES as HANDLE_CODES,
  RiskForkMcpPortableHandleError,
  createMcpPortableHandleRegistry,
} from '../src/mcp-portable-handle-boundary.mjs';
import {
  createMcpDestinationPolicy,
  createMcpTransportResultSchema,
  createMcpWireHeaders,
  createMcpWireParams,
  createMcpWireResultMetadataEvidence,
  createUnsupportedMcpWireResultError,
  validateMcpHttpPhaseOperation,
  validateMcpWireResultMetadataEvidence,
  validateMcpWireResultRejectionEvidence,
} from '../src/mcp-transport-contract.mjs';

const SEED = 0x5eed2026;
const ITERATIONS = 64;
const NOW = '2030-01-01T00:00:00.000Z';
const ENDPOINT = 'https://mcp.public-example.net/rpc';

function deterministicValues(seed = SEED) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function assertHandleCode(code) {
  return (error) => error instanceof RiskForkMcpPortableHandleError && error.code === code;
}

function append(lifecycle, to, options = {}) {
  return transitionLifecycle(lifecycle, {
    actor: 'clean_controller',
    expected_version: lifecycle.version,
    expected_chain_head: lifecycle.chain_head,
    to,
    at: NOW,
    reason: options.reason ?? `fuzz_${to.toLowerCase()}`,
    evidence: options.evidence ?? {
      status: 'observed',
      ref: `fuzz:${to.toLowerCase()}`,
      hash: sha256Ref(`${to}:${lifecycle.version + 1}`),
    },
    ...(options.resource ? { fork_resource_state: options.resource } : {}),
  });
}

function makeToolOperation(index, values) {
  const toolDescriptor = {
    name: `read_public_data_${index}`,
    inputSchema: {
      type: 'object',
      properties: {
        region: { type: 'string', 'x-mcp-header': 'Region' },
        count: { type: 'integer', 'x-mcp-header': 'Count' },
        preview: { type: 'boolean', 'x-mcp-header': 'Preview' },
      },
    },
  };
  const params = { name: toolDescriptor.name, arguments: values };
  const resultSchema = { type: 'object' };
  const responseSchema = createMcpTransportResultSchema(resultSchema);
  const toolDescriptorHash = sha256Ref(toolDescriptor);
  const toolInputSchemaHash = sha256Ref(toolDescriptor.inputSchema);
  const operation = {
    schema: 'agoragentic.risk-fork.mcp-child-operation.v1',
    kind: 'mcp_http_phase',
    mcp_request_hash: sha256Ref(`request:headers:${index}`),
    phase: 'tools/call',
    mcp_server_ref: ENDPOINT,
    mcp_server_origin: new URL(ENDPOINT).origin,
    tool_name: toolDescriptor.name,
    tool_descriptor_hash: toolDescriptorHash,
    tool_input_schema: toolDescriptor.inputSchema,
    tool_input_schema_hash: toolInputSchemaHash,
    tool_effect_status: 'explicit_read_only',
    tool_safety_binding_hash: sha256Ref({
      tool_name: toolDescriptor.name,
      tool_descriptor_hash: toolDescriptorHash,
      effect: 'explicit_read_only',
    }),
    params,
    protocol_version: '2026-07-28',
    destination_policy: createMcpDestinationPolicy({
      href: ENDPOINT,
      origin: new URL(ENDPOINT).origin,
    }),
    redirects: 'error',
    response_mode: 'json_or_sse',
    mcp_result_schema: resultSchema,
    mcp_result_schema_hash: sha256Ref(resultSchema),
    response_schema: responseSchema,
    response_schema_hash: sha256Ref(responseSchema),
    max_response_bytes: 64 * 1024,
    timeout_ms: 5_000,
    operation_hash: null,
  };
  operation.operation_hash = sha256Ref({ ...operation, operation_hash: null });
  return operation;
}

test('seeded request metadata and annotated header/body bindings reject substitution', () => {
  const next = deterministicValues();
  for (let index = 0; index < ITERATIONS; index += 1) {
    const values = {
      region: `region-${next()}`,
      count: next() % 10_000,
      preview: next() % 2 === 0,
    };
    const operation = validateMcpHttpPhaseOperation(makeToolOperation(index, values));
    const headers = createMcpWireHeaders(operation);
    const params = createMcpWireParams(operation);

    assert.equal(headers['Mcp-Method'], 'tools/call');
    assert.equal(headers['Mcp-Name'], operation.params.name);
    assert.equal(headers['Mcp-Param-Region'], values.region);
    assert.equal(headers['Mcp-Param-Count'], String(values.count));
    assert.equal(headers['Mcp-Param-Preview'], String(values.preview));
    assert.deepEqual(params.arguments, values);
    assert.deepEqual(params._meta, {
      'io.modelcontextprotocol/clientCapabilities': {},
      'io.modelcontextprotocol/clientInfo': {
        name: '@agoragentic/risk-fork',
        version: '0.1.0-alpha.1',
      },
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
    });

    const bodySubstitution = {
      ...operation,
      params: {
        ...operation.params,
        arguments: { ...values, count: values.count + 1 },
      },
    };
    assert.throws(() => createMcpWireParams(bodySubstitution), /operation hash (?:binding|mismatch)/i);
    assert.throws(() => createMcpWireHeaders(bodySubstitution), /operation hash (?:binding|mismatch)/i);

    const protocolSubstitution = { ...operation, protocol_version: '2025-11-25' };
    assert.throws(
      () => createMcpWireParams(protocolSubstitution),
      /operation contract|protocol version|hash/i,
    );

    const wrongType = makeToolOperation(index, { ...values, count: `${values.count}` });
    assert.throws(() => createMcpWireHeaders(wrongType), /annotated type/i);
  }
});

test('seeded wire-result mutations preserve typed, hash-bound, no-retry evidence', () => {
  const next = deterministicValues();
  const cacheablePhases = [
    'server/discover',
    'tools/list',
    'resources/list',
    'resources/read',
    'prompts/list',
  ];
  const unsupportedTypes = ['input_required', 'task', 'other'];

  for (let index = 0; index < ITERATIONS; index += 1) {
    const phase = cacheablePhases[next() % cacheablePhases.length];
    const wireResult = {
      resultType: 'complete',
      ttlMs: next() % 100_000,
      cacheScope: next() % 2 === 0 ? 'public' : 'private',
      _meta: { fuzzCase: index, server: `fixture-${next()}` },
    };
    const evidence = createMcpWireResultMetadataEvidence(wireResult, phase);
    assert.equal(validateMcpWireResultMetadataEvidence(evidence, phase), evidence);
    assert.equal(JSON.stringify(evidence).includes(wireResult._meta.server), false);
    assert.throws(
      () => validateMcpWireResultMetadataEvidence(
        { ...evidence, ttl_ms: evidence.ttl_ms + 1 },
        phase,
      ),
      /hash mismatch/i,
    );

    const resultType = unsupportedTypes[next() % unsupportedTypes.length];
    const rejectedResult = {
      resultType,
      inputRequests: [{ prompt: `raw-input-${index}` }],
      requestState: { opaque: `raw-state-${next()}` },
    };
    const error = createUnsupportedMcpWireResultError(rejectedResult, 'tools/call');
    const rejection = validateMcpWireResultRejectionEvidence(
      error.rejection_evidence,
      'tools/call',
    );
    assert.equal(rejection.automatic_retry, false);
    assert.equal(rejection.task_extension_enabled, false);
    assert.equal(rejection.subscription_stream_enabled, false);
    const serialized = JSON.stringify(rejection);
    assert.equal(serialized.includes(`raw-input-${index}`), false);
    assert.equal(serialized.includes('raw-state-'), false);
  }
});

test('seeded capability downgrades and plan mutations fail closed', () => {
  const required = [
    'can_block_before_remote_connect',
    'can_route_complete_remote_session',
    'can_block_before_tool_execution',
    'can_route_tool_execution',
  ];
  const plan = {
    schema: 'agoragentic.risk-fork.interception-plan.v1',
    directive: 'BLOCK_DIRECT_ROUTE_TO_RISK_FORK',
    enforcement_point: 'before_remote_connect',
    required_host_capabilities: required,
    authority_flags: {
      plan_grants_authority: false,
      host_enforcement_proven: false,
      remote_connection_started: false,
      tool_execution_started: false,
    },
    plan_hash: null,
  };
  plan.plan_hash = sha256Ref({ ...plan, plan_hash: null });
  const completeHost = Object.fromEntries(required.map((capability) => [capability, true]));
  assert.equal(assertHostCanEnforce(plan, completeHost), true);

  for (let index = 0; index < ITERATIONS; index += 1) {
    const missing = required[index % required.length];
    const downgradedHost = { ...completeHost, [missing]: index % 2 === 0 ? false : undefined };
    assert.throws(() => assertHostCanEnforce(plan, downgradedHost), new RegExp(missing));
  }

  const tamperedPlan = { ...plan, required_host_capabilities: required.slice(1) };
  assert.throws(() => assertHostCanEnforce(tamperedPlan, completeHost), /hash mismatch/i);
});

test('seeded portable-handle context mutations and replays fail closed without raw values', () => {
  const next = deterministicValues();

  for (let index = 0; index < ITERATIONS; index += 1) {
    const handle = `portable_handle_${index}_caf\u00e9`;
    const principal = sha256Ref(`principal:${index}`);
    const base = {
      handle_value: handle,
      principal_ref: principal,
      issuer: 'https://identity.example.com/',
      audience: 'https://mcp.example.com/rpc',
      mcp_server_origin: 'https://mcp.example.com',
      originating_method: 'tools/call',
      originating_request_hash: sha256Ref(`request:origin:${index}`),
    };
    const registry = createMcpPortableHandleRegistry({ clock: () => new Date(NOW) });
    const binding = registry.register({
      ...base,
      allowed_consuming_methods: ['tools/call'],
      ttl_ms: 60_000,
      single_use: false,
      max_consumptions: 2,
    });
    const authorization = {
      ...base,
      binding,
      consuming_method: 'tools/call',
      consuming_request_hash: sha256Ref(`request:consume:${index}`),
    };
    const mismatchCases = [
      { principal_ref: sha256Ref(`principal:other:${next()}`) },
      { issuer: 'https://identity.other.example/' },
      { audience: 'https://mcp.example.com/other' },
      {
        audience: 'https://other-mcp.example.com/rpc',
        mcp_server_origin: 'https://other-mcp.example.com',
      },
      { originating_method: 'resources/read' },
      { originating_request_hash: sha256Ref(`request:other:${next()}`) },
    ];
    const mismatch = mismatchCases[next() % mismatchCases.length];
    assert.throws(
      () => registry.authorize({ ...authorization, ...mismatch }),
      assertHandleCode(HANDLE_CODES.CONTEXT_MISMATCH),
    );
    const decision = registry.authorize(authorization);
    const serialized = JSON.stringify({ binding, decision });
    assert.equal(serialized.includes(handle), false);
    assert.equal(serialized.includes(principal), false);
    assert.throws(
      () => registry.authorize(authorization),
      assertHandleCode(HANDLE_CODES.REPLAY),
    );
    registry.close();
  }
});

test('seeded cleanup outcome races cannot overwrite the winning lifecycle head', () => {
  const next = deterministicValues();
  for (let index = 0; index < ITERATIONS; index += 1) {
    let lifecycle = createLifecycle({
      run_id: `run:fuzz-cleanup:${index}`,
      requested_at: NOW,
      actor: 'clean_controller',
      reason: 'fuzz_requested',
      evidence: { status: 'observed', ref: 'fuzz:requested', hash: sha256Ref(index) },
    });
    lifecycle = append(lifecycle, 'ABORTING');
    lifecycle = append(lifecycle, 'ABORTED');
    lifecycle = append(lifecycle, 'DESTROYING', { resource: 'DESTROY_REQUESTED' });
    const stale = lifecycle;
    const destroyedWins = next() % 2 === 0;
    const winner = append(lifecycle, destroyedWins ? 'DESTROYED' : 'DESTRUCTION_UNKNOWN', {
      resource: destroyedWins ? 'DESTROYED' : 'DESTROY_UNKNOWN',
      evidence: destroyedWins
        ? { status: 'verified', ref: 'cleanup:fuzz', hash: sha256Ref(`cleanup:${index}`) }
        : { status: 'unknown', detail: `cleanup_outcome_unknown_${index}` },
    });
    assert.equal(verifyLifecycle(winner), true);

    assert.throws(
      () => transitionLifecycle(winner, {
        actor: 'clean_controller',
        expected_version: stale.version,
        expected_chain_head: stale.chain_head,
        to: destroyedWins ? 'DESTRUCTION_UNKNOWN' : 'DESTROYED',
        at: NOW,
        reason: 'stale_cleanup_winner',
        evidence: destroyedWins
          ? { status: 'unknown', detail: 'stale_unknown' }
          : { status: 'verified', ref: 'cleanup:stale', hash: sha256Ref('stale') },
        fork_resource_state: destroyedWins ? 'DESTROY_UNKNOWN' : 'DESTROYED',
      }),
      /version conflict/i,
    );
  }
});
