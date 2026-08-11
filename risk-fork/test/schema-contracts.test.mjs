import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

import { LocalReferenceRiskForkAdapter } from '../src/adapters/local-reference.mjs';
import {
  FileAuthorizationClaimStore,
  commitPreparedArtifact,
} from '../src/clean-commit.mjs';
import { networkPolicy } from '../src/contracts.mjs';
import { createMcpInterceptionPlan } from '../src/interception.mjs';
import { createRiskForkReceipt } from '../src/receipt.mjs';
import { classifyRisk } from '../src/risk-classifier.mjs';
import { validateCommitCandidate } from '../src/taint-gate.mjs';
import {
  NOW,
  advanceToCommitting,
  closedResultSchema,
  hash,
  makeBinding,
  makeCapsule,
  makeForkIdentity,
  makePreparedLifecycle,
} from './helpers.mjs';

const SCHEMA_DIRECTORY = fileURLToPath(new URL('../schema/', import.meta.url));
const SCHEMA_ID_BASE = 'https://agoragentic.com/schema/';
const EXPECTED_SCHEMA_FILES = Object.freeze([
  'authorization-claim.v1.json',
  'clean-commit-result.v1.json',
  'commit-artifact.v1.json',
  'execution-binding.v1.json',
  'fork-identity.v1.json',
  'interception-plan.v1.json',
  'lifecycle.v1.json',
  'network-policy.v1.json',
  'provider-capabilities.v1.json',
  'receipt.v1.json',
  'risk-decision.v1.json',
  'savepoint-capsule.v1.json',
]);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadSchemaRegistry() {
  const files = (await readdir(SCHEMA_DIRECTORY))
    .filter((name) => name.endsWith('.json'))
    .sort();
  assert.deepEqual(files, EXPECTED_SCHEMA_FILES, 'the public Risk Fork schema family changed');

  const schemas = await Promise.all(files.map(async (file) => (
    JSON.parse(await readFile(path.join(SCHEMA_DIRECTORY, file), 'utf8'))
  )));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const schema of schemas) ajv.addSchema(schema);
  for (const schema of schemas) {
    assert.ok(ajv.getSchema(schema.$id), `AJV did not compile ${schema.$id}`);
  }
  return ajv;
}

function schemaId(name) {
  if (name === 'fork-identity.v1.json') return `${SCHEMA_ID_BASE}risk-fork-identity.v1.json`;
  return `${SCHEMA_ID_BASE}risk-fork-${name}`;
}

function assertSchemaAccepts(ajv, name, value, label = name) {
  const validate = ajv.getSchema(schemaId(name));
  assert.ok(validate, `schema is not registered: ${name}`);
  assert.equal(
    validate(value),
    true,
    `${label} must satisfy ${name}: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
  );
}

function assertSchemaRejects(ajv, name, value, label) {
  const validate = ajv.getSchema(schemaId(name));
  assert.ok(validate, `schema is not registered: ${name}`);
  assert.equal(validate(value), false, `${label} must be rejected by ${name}`);
}

function evidenceClaim(name) {
  return {
    status: 'verified',
    outcome: 'success',
    evidence_ref: `evidence:${name}`,
    evidence_hash: hash(name),
  };
}

function makeRiskInput() {
  return {
    request_id: 'request:schema-contracts',
    mcp_phase: 'tools/call',
    mcp_server_ref: 'mcp-server:1',
    mcp_server_origin: 'https://mcp.example.invalid/',
    mcp_server_trust: 'verified',
    tool_name: 'example_tool',
    capabilities: { external_side_effect: true },
    owner_policy: { minimum_level: 'HIGH' },
  };
}

test('all public Risk Fork schemas compile under strict AJV 2020', async () => {
  const ajv = await loadSchemaRegistry();
  assert.equal(Object.keys(ajv.schemas).length >= EXPECTED_SCHEMA_FILES.length, true);
});

test('schemas accept representative source-generated Risk Fork artifacts', async () => {
  const ajv = await loadSchemaRegistry();
  const capsule = makeCapsule();
  const identity = makeForkIdentity(capsule);
  const binding = makeBinding({ capsule, identity, action_operation: 'mcp_tool_call' });
  const policy = networkPolicy({ mode: 'blocked' });
  const riskInput = makeRiskInput();
  const decision = classifyRisk(riskInput);
  const interceptionPlan = createMcpInterceptionPlan({ risk_input: riskInput });
  const provider = new LocalReferenceRiskForkAdapter();

  const resultSchema = closedResultSchema();
  const typedArtifact = validateCommitCandidate({
    candidate: {
      type: 'TYPED_RESULT',
      payload: { answer: 'schema-valid' },
      payload_schema: resultSchema,
    },
    source_fork_id: 'fork:typed',
    policy: { typed_result_schema_hash: hash(resultSchema) },
    validated_at: NOW,
  });
  const actionArtifact = validateCommitCandidate({
    candidate: {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: {
        operation: 'mcp_tool_call',
        target_ref: capsule.proposed_interaction.target_ref,
        provider_ref: binding.provider_ref,
        arguments: { value: 1 },
        amount: null,
        currency: null,
        payment_rail: null,
      },
    },
    source_fork_id: 'fork:action',
    execution_binding: binding,
    validated_at: NOW,
  });
  const actionLifecycle = makePreparedLifecycle(actionArtifact.artifact_hash);
  const actionDestructionClaim = evidenceClaim('destruction');
  const receipt = createRiskForkReceipt({
    created_at: NOW,
    capsule,
    risk_decision: decision,
    lifecycle: actionLifecycle,
    fork_identity: identity,
    fork_ref: actionArtifact.source_fork_id,
    provider_ref: binding.provider_ref,
    provider_capabilities_hash: hash(provider.capabilities),
    savepoint_claim: evidenceClaim('savepoint'),
    fork_start_claim: evidenceClaim('fork-start'),
    execution_claim: evidenceClaim('execution'),
    result_digest: actionLifecycle.events.find((event) => event.to === 'TAINTED').evidence.hash,
    commit_artifact: actionArtifact,
    accepted_commit_digest: null,
    validation_evidence_refs: ['validation:taint-gate'],
    credential_revocation_claim: {
      status: 'not_applicable',
      outcome: 'not_applicable',
    },
    destruction_claim: actionDestructionClaim,
    destruction_evidence: {
      status: 'verified',
      provider_ref: binding.provider_ref,
      fork_ref: actionArtifact.source_fork_id,
      evidence_ref: actionDestructionClaim.evidence_ref,
      evidence_hash: actionDestructionClaim.evidence_hash,
    },
    transaction_assurance_evidence_refs: [],
    measurements: { total_ms: 10 },
  });

  const typedLifecycle = makePreparedLifecycle(typedArtifact.artifact_hash);
  const commitClaimStore = {
    async claim() {
      return { status: 'claimed', claim_token: 'schema-test-claim-token' };
    },
    async complete() {
      return { status: 'completed' };
    },
  };
  const cleanCommitResult = await commitPreparedArtifact({
    capsule,
    fork_identity: identity,
    lifecycle: advanceToCommitting(typedLifecycle),
    artifact: typedArtifact,
    destruction_evidence: {
      status: 'verified',
      provider_ref: 'provider:1',
      fork_ref: typedArtifact.source_fork_id,
      evidence_ref: 'cleanup:verified',
      evidence_hash: hash('cleanup'),
    },
    expected_parent_state_hash: capsule.parent.state_hash,
    current_parent_state_hash: capsule.parent.state_hash,
    verifyCommitApproval: async (request) => ({
      status: 'verified',
      artifact_hash: request.artifact_hash,
      capsule_hash: request.capsule_hash,
      parent_state_hash: request.parent_state_hash,
      evidence_ref: 'approval:verified',
      evidence_hash: hash('approval'),
    }),
    commitClaimStore,
    acceptTypedResult: async (payload) => ({ accepted: payload.answer }),
    now: NOW,
  });

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'risk-fork-schema-'));
  let authorizationClaim;
  let completedAuthorizationClaim;
  try {
    const claimStore = await new FileAuthorizationClaimStore({
      directory: path.join(temporaryRoot, 'claims'),
      clock: () => NOW,
    }).initialize();
    authorizationClaim = await claimStore.claim({
      authorizationId: binding.one_use_authorization_id,
      bindingHash: binding.binding_hash,
    });
    completedAuthorizationClaim = await claimStore.complete({
      authorizationId: binding.one_use_authorization_id,
      bindingHash: binding.binding_hash,
      claimToken: authorizationClaim.claim_token,
      resultHash: hash('clean-result'),
    });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const artifacts = [
    ['savepoint-capsule.v1.json', capsule],
    ['fork-identity.v1.json', identity],
    ['execution-binding.v1.json', binding],
    ['network-policy.v1.json', policy],
    ['risk-decision.v1.json', decision],
    ['interception-plan.v1.json', interceptionPlan],
    ['provider-capabilities.v1.json', provider.capabilities],
    ['lifecycle.v1.json', actionLifecycle],
    ['commit-artifact.v1.json', typedArtifact, 'typed commit artifact'],
    ['commit-artifact.v1.json', actionArtifact, 'consequential action artifact'],
    ['authorization-claim.v1.json', authorizationClaim.record, 'claimed authorization'],
    ['authorization-claim.v1.json', completedAuthorizationClaim, 'completed authorization'],
    ['clean-commit-result.v1.json', cleanCommitResult],
    ['receipt.v1.json', receipt],
  ];
  for (const [name, value, label] of artifacts) {
    assertSchemaAccepts(ajv, name, value, label);
  }
  assert.equal(receipt.interaction.action_operation, 'mcp_tool_call');
});

test('schemas reject boundary weakening and contract drift', async () => {
  const ajv = await loadSchemaRegistry();
  const capsule = makeCapsule();
  const identity = makeForkIdentity(capsule);
  const binding = makeBinding({ capsule, identity, action_operation: 'mcp_tool_call' });
  const actionArtifact = validateCommitCandidate({
    candidate: {
      type: 'CONSEQUENTIAL_ACTION_PROPOSAL',
      action: {
        operation: 'mcp_tool_call',
        target_ref: capsule.proposed_interaction.target_ref,
        provider_ref: binding.provider_ref,
        arguments: { value: 1 },
        amount: null,
        currency: null,
        payment_rail: null,
      },
    },
    source_fork_id: 'fork:negative',
    execution_binding: binding,
    validated_at: NOW,
  });
  const decision = classifyRisk(makeRiskInput());
  const negativeDestructionClaim = evidenceClaim('destruction');
  const negativeLifecycle = makePreparedLifecycle(actionArtifact.artifact_hash);
  const receipt = createRiskForkReceipt({
    created_at: NOW,
    capsule,
    risk_decision: decision,
    lifecycle: negativeLifecycle,
    fork_identity: identity,
    fork_ref: actionArtifact.source_fork_id,
    provider_ref: binding.provider_ref,
    provider_capabilities_hash: hash('provider-capabilities'),
    savepoint_claim: evidenceClaim('savepoint'),
    fork_start_claim: evidenceClaim('fork-start'),
    execution_claim: evidenceClaim('execution'),
    result_digest: negativeLifecycle.events.find((event) => event.to === 'TAINTED').evidence.hash,
    commit_artifact: actionArtifact,
    credential_revocation_claim: { status: 'not_applicable' },
    destruction_claim: negativeDestructionClaim,
    destruction_evidence: {
      status: 'verified',
      provider_ref: binding.provider_ref,
      fork_ref: actionArtifact.source_fork_id,
      evidence_ref: negativeDestructionClaim.evidence_ref,
      evidence_hash: negativeDestructionClaim.evidence_hash,
    },
  });

  assertSchemaRejects(
    ajv,
    'savepoint-capsule.v1.json',
    { ...clone(capsule), raw_memory: 'forbidden' },
    'capsule with an extra raw-memory field',
  );

  const missingAllowedCommitTypes = clone(capsule);
  delete missingAllowedCommitTypes.allowed_commit_types;
  assertSchemaRejects(
    ajv,
    'savepoint-capsule.v1.json',
    missingAllowedCommitTypes,
    'capsule without allowed_commit_types',
  );

  const missingExecutionAuthorization = clone(capsule);
  delete missingExecutionAuthorization.execution_authorization;
  assertSchemaRejects(
    ajv,
    'savepoint-capsule.v1.json',
    missingExecutionAuthorization,
    'capsule without execution_authorization',
  );

  for (const [field, hashField] of [
    ['lineage_ref', 'lineage_hash'],
    ['mandate_version', 'mandate_hash'],
    ['budget_version', 'budget_hash'],
  ]) {
    const mismatchedPair = clone(capsule);
    const container = field === 'lineage_ref' ? mismatchedPair.parent : mismatchedPair.governance;
    container[hashField] = null;
    assertSchemaRejects(
      ajv,
      'savepoint-capsule.v1.json',
      mismatchedPair,
      `capsule with unmatched ${field}/${hashField}`,
    );
  }

  const selfVerifiedAbsentSnapshot = clone(capsule);
  selfVerifiedAbsentSnapshot.runtime_snapshot.verification_status = 'verified';
  assertSchemaRejects(
    ajv,
    'savepoint-capsule.v1.json',
    selfVerifiedAbsentSnapshot,
    'capsule self-verifying an absent runtime snapshot',
  );

  for (const secret of ['api_key=abcdefghijklmnop', 'sk-abcdefghijklmnop']) {
    const capsuleSecretKind = clone(capsule);
    capsuleSecretKind.memory_roots = [{
      ref: 'memory:root:1',
      digest: hash('memory-root'),
      kind: secret,
      truncation_possible: false,
    }];
    assertSchemaRejects(
      ajv,
      'savepoint-capsule.v1.json',
      capsuleSecretKind,
      `capsule memory kind containing ${secret.split(/[=-]/, 1)[0]}`,
    );

    const genericSecretRef = clone(identity);
    genericSecretRef.parent_agent_id = secret;
    assertSchemaRejects(
      ajv,
      'fork-identity.v1.json',
      genericSecretRef,
      `generic opaque ref containing ${secret.split(/[=-]/, 1)[0]}`,
    );
  }

  const memoryMerge = clone(actionArtifact);
  memoryMerge.commit_type = 'memory_merge';
  assertSchemaRejects(
    ajv,
    'commit-artifact.v1.json',
    memoryMerge,
    'memory_merge commit artifact',
  );

  const missingOperation = clone(binding);
  delete missingOperation.action_operation;
  assertSchemaRejects(
    ajv,
    'execution-binding.v1.json',
    missingOperation,
    'execution binding without action_operation',
  );

  assertSchemaRejects(
    ajv,
    'network-policy.v1.json',
    { ...clone(networkPolicy({ mode: 'blocked' })), mode: 'allowlist', allowlist: ['not-a-url'] },
    'network allowlist containing a non-URL value',
  );

  const authorityFlip = clone(receipt);
  authorityFlip.authority_flags.can_spend = true;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    authorityFlip,
    'receipt claiming spending authority',
  );

  const privacyFlip = clone(receipt);
  privacyFlip.privacy.credentials_excluded = false;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    privacyFlip,
    'receipt claiming credentials were included',
  );

  const missingForkHash = clone(receipt);
  delete missingForkHash.fork.fork_ref_hash;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    missingForkHash,
    'receipt without fork_ref_hash',
  );

  const missingTimestamps = clone(receipt);
  delete missingTimestamps.timestamps;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    missingTimestamps,
    'receipt without timestamps',
  );

  const missingResultDigest = clone(receipt);
  missingResultDigest.taint.result_digest = null;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    missingResultDigest,
    'successful execution receipt without result digest',
  );

  const missingExecutionTimestamp = clone(receipt);
  missingExecutionTimestamp.timestamps.execution_completed_at = null;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    missingExecutionTimestamp,
    'successful execution receipt without completion timestamp',
  );

  const honestFailureShape = clone(receipt);
  honestFailureShape.claims.execution.status = 'failed';
  honestFailureShape.claims.execution.outcome = 'failure';
  honestFailureShape.taint.result_digest = null;
  assertSchemaAccepts(
    ajv,
    'receipt.v1.json',
    honestFailureShape,
    'failed execution receipt without a result digest',
  );

  const failedExecutionWithDigest = clone(honestFailureShape);
  failedExecutionWithDigest.taint.result_digest = hash('not-a-successful-result');
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    failedExecutionWithDigest,
    'failed execution receipt carrying a result digest',
  );

  const halfTimestampedFailure = clone(honestFailureShape);
  halfTimestampedFailure.timestamps.execution_completed_at = null;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    halfTimestampedFailure,
    'failed execution receipt with only one execution timestamp',
  );

  const invalidExecutionClaimPair = clone(honestFailureShape);
  invalidExecutionClaimPair.claims.execution.outcome = 'success';
  invalidExecutionClaimPair.timestamps.execution_started_at = null;
  invalidExecutionClaimPair.timestamps.execution_completed_at = null;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    invalidExecutionClaimPair,
    'execution receipt with an invalid failed/success claim pair',
  );

  const neutralExecutionWithTimestamps = clone(honestFailureShape);
  neutralExecutionWithTimestamps.claims.execution.status = 'unknown';
  neutralExecutionWithTimestamps.claims.execution.outcome = 'unknown';
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    neutralExecutionWithTimestamps,
    'neutral execution receipt carrying execution timestamps',
  );

  const committedWithoutDigest = clone(receipt);
  committedWithoutDigest.lifecycle.state = 'COMMITTED';
  committedWithoutDigest.commit.accepted_digest = null;
  committedWithoutDigest.timestamps.committed_at = committedWithoutDigest.created_at;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    committedWithoutDigest,
    'committed receipt without accepted digest',
  );

  const committedWithoutTimestamp = clone(receipt);
  committedWithoutTimestamp.lifecycle.state = 'COMMITTED';
  committedWithoutTimestamp.commit.accepted_digest = actionArtifact.artifact_hash;
  committedWithoutTimestamp.timestamps.committed_at = null;
  assertSchemaRejects(
    ajv,
    'receipt.v1.json',
    committedWithoutTimestamp,
    'committed receipt without committed timestamp',
  );

  for (const secret of ['api_key=abcdefghijklmnop', 'sk-abcdefghijklmnop']) {
    const secretDetail = clone(receipt);
    secretDetail.claims.execution.detail = secret;
    assertSchemaRejects(
      ajv,
      'receipt.v1.json',
      secretDetail,
      `receipt claim detail containing ${secret.split(/[=-]/, 1)[0]}`,
    );
  }
});
