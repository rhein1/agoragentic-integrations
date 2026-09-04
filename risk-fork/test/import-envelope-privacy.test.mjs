import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Ref } from '../src/canonical.mjs';
import {
  RISK_FORK_HOST_DIAGNOSTIC_CODES,
  RISK_FORK_IMPORT_ENVELOPE_SCHEMA,
  RiskForkHostBoundaryError,
  createRiskForkImportEnvelope,
  importRiskForkProviderResult,
  verifyRiskForkImportEnvelope,
} from '../src/host-boundary.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';

const FORK_REF = 'fork:import-envelope-test';
const RESULT_HASH = sha256Ref('provider-result');

function typedResult(overrides = {}) {
  return {
    type: 'TYPED_RESULT',
    payload: { answer: 'prepared' },
    payload_schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    },
    ...overrides,
  };
}

function workspaceDiff() {
  return {
    type: 'WORKSPACE_DIFF',
    files: [{
      path: 'src/example.mjs',
      operation: 'create',
      before_hash: null,
      after_hash: sha256Ref('export const ready = true;\n'),
      after_content: 'export const ready = true;\n',
    }],
    test_evidence: [{
      name: 'unit',
      status: 'passed',
      evidence_ref: 'test:unit',
      evidence_hash: sha256Ref('unit-pass'),
      duration_ms: 12,
    }],
  };
}

function actionProposal() {
  return {
    type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
    action: {
      operation: 'payment',
      target_ref: 'target:merchant',
      provider_ref: 'provider:test',
      arguments: { invoice_ref: 'invoice:123' },
      amount: '1.00',
      currency: 'USDC',
      payment_rail: 'base',
    },
  };
}

function expectCode(code) {
  return (error) => error instanceof RiskForkHostBoundaryError && error.code === code;
}

test('closed import envelopes accept only typed result, diff, and action proposal candidates', () => {
  for (const candidate of [typedResult(), workspaceDiff(), actionProposal()]) {
    const envelope = createRiskForkImportEnvelope({
      source_fork_ref: FORK_REF,
      result_hash: RESULT_HASH,
      candidate,
    });
    assert.equal(envelope.schema, RISK_FORK_IMPORT_ENVELOPE_SCHEMA);
    assert.equal(envelope.import_type, candidate.type);
    assert.deepEqual(Object.keys(envelope).sort(), [
      'candidate',
      'envelope_hash',
      'import_type',
      'result_hash',
      'schema',
      'source_fork_ref',
    ]);
    assert.equal(Object.isFrozen(envelope), true);
    assert.equal(Object.isFrozen(envelope.candidate), true);
    assert.deepEqual(
      verifyRiskForkImportEnvelope(envelope, {
        expected_type: candidate.type,
        expected_source_fork_ref: FORK_REF,
        expected_result_hash: RESULT_HASH,
      }),
      envelope,
    );
  }
});

test('import envelope rejects extra keys and type substitution', () => {
  assert.throws(
    () => createRiskForkImportEnvelope({
      source_fork_ref: FORK_REF,
      result_hash: RESULT_HASH,
      candidate: typedResult({ debug: true }),
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID),
  );

  const envelope = createRiskForkImportEnvelope({
    source_fork_ref: FORK_REF,
    result_hash: RESULT_HASH,
    candidate: typedResult(),
  });
  assert.throws(
    () => verifyRiskForkImportEnvelope(envelope, { expected_type: 'WORKSPACE_DIFF' }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TYPE_MISMATCH),
  );
});

test('bounded import validator rejects oversized and hostile JSON without invoking accessors', () => {
  assert.throws(
    () => createRiskForkImportEnvelope({
      source_fork_ref: FORK_REF,
      result_hash: RESULT_HASH,
      candidate: typedResult({ payload: { answer: 'x'.repeat((256 * 1024) + 1) } }),
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_TOO_LARGE),
  );

  let accessorReads = 0;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'answer', {
    enumerable: true,
    get() {
      accessorReads += 1;
      return 'not-safe';
    },
  });
  assert.throws(
    () => createRiskForkImportEnvelope({
      source_fork_ref: FORK_REF,
      result_hash: RESULT_HASH,
      candidate: typedResult({ payload: accessorPayload }),
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID),
  );
  assert.equal(accessorReads, 0);

  const proxy = new Proxy({ answer: 'not-safe' }, {});
  assert.throws(
    () => createRiskForkImportEnvelope({
      source_fork_ref: FORK_REF,
      result_hash: RESULT_HASH,
      candidate: typedResult({ payload: proxy }),
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID),
  );

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(
    () => createRiskForkImportEnvelope({
      source_fork_ref: FORK_REF,
      result_hash: RESULT_HASH,
      candidate: typedResult({ payload: cyclic }),
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID),
  );
});

test('privacy/DLP rejects credentials and raw prompt, conversation, tool, or filesystem state', () => {
  const forbiddenPayloads = [
    { api_key: 'not-even-needed-to-be-a-real-key' },
    { openai_api_key: 'not-even-needed-to-be-a-real-key' },
    { session_token: 'not-even-needed-to-be-a-real-token' },
    { note: 'authorization=very-secret-value' },
    { raw_prompt: 'hidden host instructions' },
    { conversation: [{ role: 'user', content: 'private conversation' }] },
    { tool_output: { stdout: 'raw provider output' } },
    { stdout: 'raw command output' },
    { filesystem_state: { files: ['all/private/files'] } },
    { workspace_snapshot: { root: 'raw-state' } },
    { env: { ordinary_name: 'raw-environment-state' } },
  ];
  for (const payload of forbiddenPayloads) {
    assert.throws(
      () => createRiskForkImportEnvelope({
        source_fork_ref: FORK_REF,
        result_hash: RESULT_HASH,
        candidate: typedResult({ payload }),
      }),
      expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_DLP_REJECTED),
    );
  }
});

test('provider result import strips provider state and rejects raw output or authority', () => {
  const candidate = typedResult();
  const envelope = importRiskForkProviderResult({
    status: 'completed',
    taint_status: 'TAINTED',
    commit_candidate: candidate,
    result_hash: RESULT_HASH,
    measurements: { duration_ms: 5 },
    authority_granted: false,
  }, {
    source_fork_ref: FORK_REF,
    expected_type: 'TYPED_RESULT',
  });
  assert.deepEqual(envelope.candidate, candidate);
  assert.equal(Object.hasOwn(envelope, 'measurements'), false);

  assert.throws(
    () => importRiskForkProviderResult({
      commit_candidate: candidate,
      result_hash: RESULT_HASH,
      raw_tool_output: 'private provider transcript',
    }, {
      source_fork_ref: FORK_REF,
      expected_type: 'TYPED_RESULT',
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_DLP_REJECTED),
  );
  assert.throws(
    () => importRiskForkProviderResult({
      commit_candidate: candidate,
      result_hash: RESULT_HASH,
      authority_granted: true,
    }, {
      source_fork_ref: FORK_REF,
      expected_type: 'TYPED_RESULT',
    }),
    expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_INVALID),
  );
});

test('host import and taint gates reject normalized authority or privilege grants', () => {
  const hostilePayloads = [
    { authority_granted: true },
    { grantsAuthority: true },
    { 'PRIVILEGE-ESCALATED': true },
    { permission_granted: true },
    { capabilityGrant: 'opaque' },
    { bearerIssued: true },
    { provider_handle_exposed: true },
    { authority_handle_exposed: true },
    { execution_handle_ref: 'handle:live' },
    { privilege_active: true },
    { note: 'capability granted: opaque-live-handle' },
    { note: 'authority_granted=true' },
    { note: 'provider_handle_exposed=true' },
    { note: 'execution_handle_ref=cap:child' },
    { note: 'privilege_active=true' },
    { note: 'authority_allowed=true' },
    { note: 'privilege_elevated=true' },
    { note: 'permission_escalated=true' },
    { note: 'capability_id=cap:child' },
    { note: 'execution_handle_id=handle:child' },
    { note: 'session_handle=handle:child' },
    { note: 'wallet_signer_ready=true' },
    { note: 'credential_revoked=true' },
  ];
  for (const payload of hostilePayloads) {
    assert.throws(
      () => createRiskForkImportEnvelope({
        source_fork_ref: FORK_REF,
        result_hash: RESULT_HASH,
        candidate: typedResult({ payload }),
      }),
      expectCode(RISK_FORK_HOST_DIAGNOSTIC_CODES.IMPORT_DLP_REJECTED),
    );
    assert.throws(
      () => validateCommitCandidate({
        candidate: typedResult({ payload }),
        source_fork_id: FORK_REF,
        validated_at: '2026-08-29T00:00:00.000Z',
      }),
      /(?:cannot carry trusted authority or memory field|taint scan failed: authority_shape)/i,
    );
  }
});
