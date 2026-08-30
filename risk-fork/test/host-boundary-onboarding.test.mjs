import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RISK_FORK_HOST_BOUNDARY_SCHEMA,
  RISK_FORK_HOST_DIAGNOSTIC_CODES,
  RiskForkHostBoundaryError,
  createRiskForkHostBoundary,
  createTrustedRiskDescriptor,
  createTrustedRiskDescriptorSource,
  isRiskForkHostBoundary,
} from '../src/host-boundary.mjs';

const NOW = '2026-08-29T14:00:00.000Z';

function completeCapabilities(overrides = {}) {
  return {
    network_access: false,
    filesystem_read: false,
    filesystem_write: true,
    credential_access: false,
    wallet_or_payment: false,
    deployment: false,
    publication: false,
    communication: false,
    database_mutation: false,
    trust_or_reputation_mutation: false,
    external_side_effect: false,
    unknown_or_unclassified: false,
    ...overrides,
  };
}

function completeAnnotations(overrides = {}) {
  return {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
    ...overrides,
  };
}

function completeOwnerPolicy(overrides = {}) {
  return {
    minimum_level: 'LOW',
    force_risk_fork: false,
    deny_irreversible: false,
    trusted_server_refs: [],
    trusted_attestor_refs: [],
    trusted_attestation_hashes: [],
    trust_registry_version: null,
    allowed_egress: [],
    ...overrides,
  };
}

function descriptorInput(overrides = {}) {
  return {
    mcp_phase: 'tools/call',
    raw_method: null,
    mcp_server_ref: 'server:example',
    mcp_server_origin: 'https://mcp.example.test',
    mcp_server_trust: 'reachable',
    mcp_server_attestation: null,
    tool_name: 'workspace_apply_patch',
    tool_annotations: completeAnnotations(),
    capabilities: completeCapabilities(),
    prompt_injection_indicators: [],
    owner_policy: completeOwnerPolicy(),
    ...overrides,
  };
}

function operationInput(operation = { kind: 'bounded_file_batch', actions: [] }) {
  return {
    operation,
    expected_commit_type: 'TYPED_RESULT',
  };
}

function makeBoundary(resolveDescriptor = (request) => (
  createTrustedRiskDescriptor(request, descriptorInput())
)) {
  const calls = [];
  const controller = {
    marker: 'host-controller',
    async prepare(input) {
      assert.equal(this.marker, 'host-controller');
      calls.push(input);
      return {
        schema: 'test.prepared-result.v1',
        mode: 'prepared_for_clean_commit',
        authority_granted: false,
      };
    },
  };
  const source = createTrustedRiskDescriptorSource(resolveDescriptor);
  const boundary = createRiskForkHostBoundary({
    controller,
    trusted_descriptor_source: source,
    clock: () => NOW,
  });
  return { boundary, calls, source };
}

test('host-owned pre-effect boundary derives risk input and exposes no provider/controller handle', async () => {
  let descriptorRequest;
  const { boundary, calls } = makeBoundary((request) => {
    descriptorRequest = request;
    return createTrustedRiskDescriptor(request, descriptorInput({
      mcp_server_origin: 'https://mcp.example.test',
      prompt_injection_indicators: ['indicator:b', 'indicator:a', 'indicator:a'],
    }));
  });

  assert.equal(boundary.schema, RISK_FORK_HOST_BOUNDARY_SCHEMA);
  assert.equal(isRiskForkHostBoundary(boundary), true);
  assert.deepEqual(Object.keys(boundary).sort(), [
    'commitPrepared',
    'mode',
    'preEffect',
    'schema',
    'validateImport',
  ]);
  assert.equal(boundary.controller, undefined);
  assert.equal(boundary.provider, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(boundary)), {
    schema: RISK_FORK_HOST_BOUNDARY_SCHEMA,
    mode: 'host_owned_pre_effect',
  });

  const result = await boundary.preEffect({
    descriptor_ref: 'descriptor:workspace-apply-patch',
    operation_input: operationInput(),
  });

  assert.equal(calls.length, 1);
  assert.equal(Object.isFrozen(descriptorRequest), true);
  assert.equal(calls[0].risk_input.mcp_server_origin, 'https://mcp.example.test/');
  assert.deepEqual(calls[0].risk_input.prompt_injection_indicators, [
    'indicator:a',
    'indicator:b',
  ]);
  assert.equal(calls[0].risk_input.tool_name, 'workspace_apply_patch');
  assert.equal(calls[0].force_optional_fork, true);
  assert.equal(Object.hasOwn(calls[0], 'risk_label'), false);
  assert.equal(result.authority_granted, false);
  assert.equal(result.provider_handle_exposed, false);
  assert.equal(result.operation_hash, descriptorRequest.operation_hash);
  assert.equal(typeof result.descriptor_hash, 'string');
  assert.equal(Object.isFrozen(result), true);
});

test('caller/model risk labels are rejected before trusted descriptor resolution', async () => {
  for (const label of [
    { risk_level: 'LOW' },
    { risk_assessment: 'safe' },
    { classification: 'read-only' },
  ]) {
    let resolutions = 0;
    const { boundary, calls } = makeBoundary((request) => {
      resolutions += 1;
      return createTrustedRiskDescriptor(request, descriptorInput());
    });

    await assert.rejects(
      boundary.preEffect({
        descriptor_ref: 'descriptor:risk-label-attempt',
        operation_input: operationInput({
          kind: 'bounded_file_batch',
          actions: [],
          ...label,
        }),
      }),
      (error) => error instanceof RiskForkHostBoundaryError
        && error.code === RISK_FORK_HOST_DIAGNOSTIC_CODES.CALLER_RISK_LABEL_REJECTED,
    );
    assert.equal(resolutions, 0);
    assert.equal(calls.length, 0);
  }
});

test('unknown or incomplete trusted metadata fails closed before controller prepare', async () => {
  for (const capabilities of [
    completeCapabilities({ unknown_or_unclassified: true }),
    undefined,
    Object.fromEntries(
      Object.entries(completeCapabilities()).filter(([key]) => key !== 'publication'),
    ),
  ]) {
    const { boundary, calls } = makeBoundary((request) => (
      createTrustedRiskDescriptor(request, descriptorInput({ capabilities }))
    ));
    await assert.rejects(
      boundary.preEffect({
        descriptor_ref: 'descriptor:unknown-metadata',
        operation_input: operationInput(),
      }),
      (error) => error instanceof RiskForkHostBoundaryError
        && error.code === RISK_FORK_HOST_DIAGNOSTIC_CODES.UNKNOWN_METADATA,
    );
    assert.equal(calls.length, 0);
  }
});

test('descriptor source capability cannot be fabricated and descriptor substitution is rejected', async () => {
  assert.throws(
    () => createRiskForkHostBoundary({
      controller: { prepare() {} },
      trusted_descriptor_source: {
        schema: 'agoragentic.risk-fork.trusted-descriptor-source.v1',
        trust_mode: 'host_callback_identity',
      },
    }),
    (error) => error instanceof RiskForkHostBoundaryError
      && error.code === RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_SOURCE_UNTRUSTED,
  );

  const source = createTrustedRiskDescriptorSource((request) => {
    const exact = createTrustedRiskDescriptor(request, descriptorInput());
    return {
      ...exact,
      descriptor_ref: 'descriptor:substituted',
    };
  });
  const boundary = createRiskForkHostBoundary({
    controller: { async prepare() { throw new Error('must not be called'); } },
    trusted_descriptor_source: source,
    clock: () => NOW,
  });
  await assert.rejects(
    boundary.preEffect({
      descriptor_ref: 'descriptor:requested',
      operation_input: operationInput(),
    }),
    (error) => error instanceof RiskForkHostBoundaryError
      && error.code === RISK_FORK_HOST_DIAGNOSTIC_CODES.DESCRIPTOR_REQUEST_MISMATCH,
  );
});

test('prepared output must remain closed JSON and cannot expose a live provider-capable handle', async () => {
  const source = createTrustedRiskDescriptorSource((request) => (
    createTrustedRiskDescriptor(request, descriptorInput())
  ));
  const boundary = createRiskForkHostBoundary({
    controller: {
      async prepare() {
        return { provider_handle: { execute() {} } };
      },
    },
    trusted_descriptor_source: source,
    clock: () => NOW,
  });
  await assert.rejects(
    boundary.preEffect({
      descriptor_ref: 'descriptor:handle-attempt',
      operation_input: operationInput(),
    }),
    (error) => error instanceof RiskForkHostBoundaryError
      && error.code === RISK_FORK_HOST_DIAGNOSTIC_CODES.INVALID_BOUNDARY_INPUT,
  );
});
