import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { sha256Ref } from '../canonical.mjs';
import { verifyExecutionBinding } from '../contracts.mjs';
import {
  DistributedAuthorityAmbiguousError,
  buildAuthorizationVerificationRequest,
  buildReconciliationVerificationRequest,
  distributedAuthorityError,
  normalizeAmbiguityRequest,
  normalizeAuthorizationRegistration,
  normalizeAuthorizationRevocation,
  normalizeCommitApprovalRegistration,
  normalizeCommitApprovalRevocation,
  normalizeDistributedPrepareRequest,
  normalizeEffectStartRequest,
  normalizeFinalizationRequest,
  normalizeGovernanceUpdate,
  normalizeParentSeed,
  normalizePreparedRecoveryRequest,
  normalizeReconciliationInput,
  verifyAuthorizationVerification,
  verifyReconciliationVerification,
} from '../distributed-authority.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  cloneJson,
  deepFreeze,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from '../util.mjs';

const POSTGRES_AUTHORITIES = new WeakMap();
const SERIALIZATION_FAILURES = new Set(['40001', '40P01']);
const MIGRATION_URL = new URL('../../migrations/001_distributed_authority.pg.sql', import.meta.url);

function quoteIdentifier(value, label = 'PostgreSQL schema name') {
  const normalized = requireString(value, label, { maxLength: 63 });
  if (!/^[a-z_][a-z0-9_]*$/.test(normalized)) {
    throw new TypeError(`${label} must be a lowercase PostgreSQL identifier`);
  }
  return `"${normalized}"`;
}

function asIso(value, label) {
  return requireIsoDate(value instanceof Date ? value : String(value), label);
}

function asVersion(value, label = 'operation version') {
  const normalized = typeof value === 'number' ? value : Number.parseInt(value, 10);
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new TypeError(`${label} must be a positive safe integer`);
  }
  return normalized;
}

function optionalIso(value, label) {
  return value == null ? null : asIso(value, label);
}

function operationFromRow(row, { idempotent = false } = {}) {
  if (!row) return null;
  return deepFreeze({
    schema: 'agoragentic.risk-fork.distributed-operation.v1',
    operation_ref: requireOpaqueRef(row.operation_ref, 'operation_ref'),
    request_hash: requireSha256Ref(row.request_hash, 'request_hash'),
    authority_request_hash: requireSha256Ref(
      row.authority_request_hash,
      'authority_request_hash',
    ),
    status: row.status,
    commit_type: row.commit_type,
    parent_ref: row.parent_ref,
    approval_key: row.approval_key,
    authorization_id: row.authorization_id ?? null,
    previous_head_hash: row.previous_head_hash,
    next_head_hash: row.next_head_hash ?? null,
    artifact_hash: row.artifact_hash,
    capsule_hash: row.capsule_hash,
    governance_hash: row.governance_hash,
    governance_evidence_hash: row.governance_evidence_hash,
    approval_evidence_ref: row.approval_evidence_ref,
    approval_evidence_hash: row.approval_evidence_hash,
    authorization_binding_hash: row.authorization_binding_hash ?? null,
    capsule_expires_at: asIso(row.capsule_expires_at, 'capsule_expires_at'),
    effect_key: row.effect_key ?? null,
    claimant_ref: row.claimant_ref ?? null,
    result: row.result == null ? null : cloneJson(row.result),
    result_hash: row.result_hash ?? null,
    transaction_hash: row.transaction_hash ?? null,
    failure_code: row.failure_code ?? null,
    failure_message: row.failure_message ?? null,
    resolution: row.resolution ?? null,
    resolution_evidence_ref: row.resolution_evidence_ref ?? null,
    resolution_evidence_hash: row.resolution_evidence_hash ?? null,
    version: asVersion(row.version),
    prepared_at: asIso(row.prepared_at, 'prepared_at'),
    effect_started_at: optionalIso(row.effect_started_at, 'effect_started_at'),
    completed_at: optionalIso(row.completed_at, 'completed_at'),
    updated_at: asIso(row.updated_at, 'updated_at'),
    idempotent,
    authority_flags: {
      operation_grants_authority: false,
      automatic_effect_retry_allowed: false,
      reconciliation_requires_trusted_verification: true,
    },
  });
}

function assertAuthority(instance) {
  const state = POSTGRES_AUTHORITIES.get(instance);
  if (!state) {
    throw new TypeError('An exact concrete PostgresDistributedCommitAuthority is required');
  }
  if (!state.pool) throw new Error('PostgreSQL distributed authority is not initialized');
  return state;
}

async function databaseNow(client) {
  const result = await client.query('SELECT clock_timestamp() AS observed_at');
  return asIso(result.rows[0].observed_at, 'PostgreSQL authority time');
}

function assertDatabaseTimeNotBefore(observedAt, operationRef, ...rows) {
  const observedMs = Date.parse(observedAt);
  for (const row of rows) {
    if (row?.updated_at != null
      && observedMs < Date.parse(asIso(row.updated_at, 'stored authority time'))) {
      throw distributedAuthorityError(
        'PostgreSQL authority time moved backward relative to durable state',
        'DISTRIBUTED_AUTHORITY_CLOCK_ROLLBACK',
        { operation_ref: operationRef ?? null, observed_at: observedAt },
      );
    }
  }
}

async function runBoundedVerification(state, callback, request, label) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => callback(request)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(distributedAuthorityError(
          `${label} exceeded the authority verification deadline`,
          'DISTRIBUTED_AUTHORITY_VERIFICATION_TIMEOUT',
          { verification: label },
        )), state.statementTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function withSerializable(state, operation) {
  for (let attempt = 0; attempt < state.maxTransactionAttempts; attempt += 1) {
    const client = await state.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
      await client.query(`SET LOCAL statement_timeout = ${state.statementTimeoutMs}`);
      await client.query(
        `SET LOCAL idle_in_transaction_session_timeout = ${state.statementTimeoutMs}`,
      );
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      if (SERIALIZATION_FAILURES.has(error?.code)
        && attempt + 1 < state.maxTransactionAttempts) {
        continue;
      }
      throw error;
    } finally {
      client.release();
    }
  }
  throw new Error('PostgreSQL distributed authority transaction retry limit exhausted');
}

function table(state, name) {
  return `${state.quotedSchema}.${name}`;
}

async function appendAudit(client, state, event) {
  const meta = await client.query(
    `SELECT audit_sequence, audit_head_hash
       FROM ${table(state, 'authority_meta')}
      WHERE authority_id = $1
      FOR UPDATE`,
    [state.authorityId],
  );
  if (meta.rowCount !== 1) throw new Error('PostgreSQL authority metadata is absent');
  const previousSequence = Number.parseInt(meta.rows[0].audit_sequence, 10);
  const sequence = previousSequence + 1;
  if (!Number.isSafeInteger(sequence)) throw new Error('Authority audit sequence overflow');
  const observedAt = event.observed_at ?? await databaseNow(client);
  const payload = cloneJson(event.payload ?? {});
  const payloadHash = sha256Ref(payload);
  const previousEventHash = meta.rows[0].audit_head_hash ?? null;
  const eventBody = {
    schema: 'agoragentic.risk-fork.distributed-authority-audit-event.v1',
    authority_id: state.authorityId,
    sequence,
    event_type: requireOpaqueRef(event.event_type, 'audit event_type'),
    operation_ref: event.operation_ref ?? null,
    parent_ref: event.parent_ref ?? null,
    authorization_id: event.authorization_id ?? null,
    observed_at: observedAt,
    previous_event_hash: previousEventHash,
    payload_hash: payloadHash,
  };
  const eventHash = sha256Ref(eventBody);
  await client.query(
    `INSERT INTO ${table(state, 'audit_events')} (
       authority_id, sequence, event_type, operation_ref, parent_ref,
       authorization_id, observed_at, previous_event_hash, payload,
       payload_hash, event_hash
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11)`,
    [
      state.authorityId,
      sequence,
      eventBody.event_type,
      eventBody.operation_ref,
      eventBody.parent_ref,
      eventBody.authorization_id,
      observedAt,
      previousEventHash,
      JSON.stringify(payload),
      payloadHash,
      eventHash,
    ],
  );
  await client.query(
    `UPDATE ${table(state, 'authority_meta')}
        SET audit_sequence = $2, audit_head_hash = $3, updated_at = $4
      WHERE authority_id = $1`,
    [state.authorityId, sequence, eventHash, observedAt],
  );
  return { sequence, event_hash: eventHash, observed_at: observedAt };
}

function parentStateError(row, expectedHead) {
  if (!row) {
    return distributedAuthorityError(
      'Distributed parent head is not initialized',
      'DISTRIBUTED_PARENT_HEAD_UNINITIALIZED',
      { expected_parent_head_hash: expectedHead },
    );
  }
  if (row.status !== 'active') {
    return new DistributedAuthorityAmbiguousError(
      'Distributed parent head has an unresolved operation',
      {
        parent_ref: row.parent_ref,
        status: row.status,
        operation_ref: row.pending_operation_ref,
        version: asVersion(row.version, 'parent version'),
      },
    );
  }
  if (!safeEqual(row.head_hash, expectedHead)) {
    return distributedAuthorityError(
      'Distributed parent head is stale',
      'DISTRIBUTED_PARENT_HEAD_STALE',
      {
        parent_ref: row.parent_ref,
        expected_parent_head_hash: expectedHead,
        observed_parent_head_hash: row.head_hash,
      },
    );
  }
  return null;
}

function authorizationStateError(row, authorizationId) {
  if (!row) {
    return distributedAuthorityError(
      'Distributed execution authorization is absent',
      'DISTRIBUTED_AUTHORIZATION_ABSENT',
      { authorization_id: authorizationId },
    );
  }
  if (row.status === 'revoked') {
    return distributedAuthorityError(
      'Distributed execution authorization is revoked',
      'DISTRIBUTED_AUTHORIZATION_REVOKED',
      { authorization_id: authorizationId },
    );
  }
  if (row.status === 'consumed') {
    return distributedAuthorityError(
      'Distributed execution authorization is consumed',
      'DISTRIBUTED_AUTHORIZATION_CONSUMED',
      { authorization_id: authorizationId },
    );
  }
  if (row.status !== 'active') {
    return new DistributedAuthorityAmbiguousError(
      'Distributed execution authorization has an unresolved operation',
      { authorization_id: authorizationId, status: row.status, operation_ref: row.operation_ref },
    );
  }
  return null;
}

async function selectOperation(client, state, operationRef, suffix = '') {
  const result = await client.query(
    `SELECT * FROM ${table(state, 'operations')}
      WHERE authority_id = $1 AND operation_ref = $2 ${suffix}`,
    [state.authorityId, operationRef],
  );
  return result.rows[0] ?? null;
}

async function lockOperationGraph(client, state, operationRef) {
  const observed = await selectOperation(client, state, operationRef);
  if (!observed) {
    throw distributedAuthorityError(
      'Distributed operation is absent',
      'DISTRIBUTED_OPERATION_ABSENT',
      { operation_ref: operationRef },
    );
  }
  const parentResult = await client.query(
    `SELECT * FROM ${table(state, 'parent_heads')}
      WHERE authority_id = $1 AND parent_ref = $2 FOR UPDATE`,
    [state.authorityId, observed.parent_ref],
  );
  const approvalResult = await client.query(
    `SELECT * FROM ${table(state, 'commit_approvals')}
      WHERE authority_id = $1 AND approval_key = $2 FOR UPDATE`,
    [state.authorityId, observed.approval_key],
  );
  let authorization = null;
  if (observed.authorization_id != null) {
    const authorizationResult = await client.query(
      `SELECT * FROM ${table(state, 'execution_authorizations')}
        WHERE authority_id = $1 AND authorization_id = $2 FOR UPDATE`,
      [state.authorityId, observed.authorization_id],
    );
    authorization = authorizationResult.rows[0] ?? null;
  }
  const operation = await selectOperation(client, state, operationRef, 'FOR UPDATE');
  if (!operation
    || operation.parent_ref !== observed.parent_ref
    || operation.approval_key !== observed.approval_key
    || operation.authorization_id !== observed.authorization_id) {
    throw new DistributedAuthorityAmbiguousError(
      'Distributed operation graph changed while its rows were locked',
      { operation_ref: operationRef },
    );
  }
  return {
    operation,
    parent: parentResult.rows[0] ?? null,
    approval: approvalResult.rows[0] ?? null,
    authorization,
  };
}

function assertLockedReservation(graph) {
  const { operation, parent, approval, authorization } = graph;
  const expectedParentStatus = operation.status === 'ambiguous' ? 'ambiguous' : 'reserved';
  const expectedAuthorizationStatus = {
    prepared: 'reserved',
    effect_started: 'effect_started',
    ambiguous: 'ambiguous',
  }[operation.status];
  if (!parent
    || parent.status !== expectedParentStatus
    || parent.pending_operation_ref !== operation.operation_ref
    || !approval
    || approval.status !== 'reserved'
    || approval.operation_ref !== operation.operation_ref
    || (operation.authorization_id !== null
      && (!authorization
        || authorization.status !== expectedAuthorizationStatus
        || authorization.operation_ref !== operation.operation_ref))) {
    throw new DistributedAuthorityAmbiguousError(
      'Distributed operation reservation graph is inconsistent',
      { operation_ref: operation.operation_ref, status: operation.status },
    );
  }
}

async function seedParent(state, input) {
  const seed = normalizeParentSeed(input);
  return withSerializable(state, async (client) => {
    const insertedAt = await databaseNow(client);
    const inserted = await client.query(
      `INSERT INTO ${table(state, 'parent_heads')} (
         authority_id, parent_ref, status, head_hash, version, updated_at
       ) VALUES ($1,$2,'active',$3,1,$4)
       ON CONFLICT (authority_id, parent_ref) DO NOTHING
       RETURNING *`,
      [state.authorityId, seed.parent_ref, seed.head_hash, insertedAt],
    );
    if (inserted.rowCount === 0) {
      const current = await client.query(
        `SELECT * FROM ${table(state, 'parent_heads')}
          WHERE authority_id = $1 AND parent_ref = $2 FOR UPDATE`,
        [state.authorityId, seed.parent_ref],
      );
      const row = current.rows[0];
      if (!row || row.status !== 'active' || !safeEqual(row.head_hash, seed.head_hash)) {
        throw distributedAuthorityError(
          'Distributed parent was already initialized differently',
          'DISTRIBUTED_PARENT_SEED_CONFLICT',
          { parent_ref: seed.parent_ref },
        );
      }
      return cloneJson(row);
    }
    await appendAudit(client, state, {
      event_type: 'parent_seeded',
      parent_ref: seed.parent_ref,
      observed_at: insertedAt,
      payload: { head_hash: seed.head_hash },
    });
    return cloneJson(inserted.rows[0]);
  });
}

async function setGovernance(state, input) {
  const update = normalizeGovernanceUpdate(input);
  return withSerializable(state, async (client) => {
    const selected = await client.query(
      `SELECT * FROM ${table(state, 'parent_heads')}
        WHERE authority_id = $1 AND parent_ref = $2 FOR UPDATE`,
      [state.authorityId, update.parent_ref],
    );
    const parent = selected.rows[0];
    const error = parentStateError(parent, parent?.head_hash ?? 'sha256:'.padEnd(71, '0'));
    if (error) throw error;
    const now = await databaseNow(client);
    if (parent.governance_hash != null && !safeEqual(parent.governance_hash, update.governance_hash)) {
      await client.query(
        `UPDATE ${table(state, 'commit_approvals')}
            SET status = 'superseded', updated_at = $3
          WHERE authority_id = $1 AND parent_ref = $2 AND status = 'active'`,
        [state.authorityId, update.parent_ref, now],
      );
    }
    const result = await client.query(
      `UPDATE ${table(state, 'parent_heads')}
          SET current_governance = $3::jsonb, governance_hash = $4,
              version = version + 1, updated_at = $5
        WHERE authority_id = $1 AND parent_ref = $2
        RETURNING *`,
      [state.authorityId, update.parent_ref, JSON.stringify(update.governance), update.governance_hash, now],
    );
    await appendAudit(client, state, {
      event_type: 'governance_set',
      parent_ref: update.parent_ref,
      observed_at: now,
      payload: {
        governance_hash: update.governance_hash,
        governance_evidence_hash: update.governance.evidence_hash,
      },
    });
    return cloneJson(result.rows[0]);
  });
}

async function registerApproval(state, input) {
  const approval = normalizeCommitApprovalRegistration(input);
  return withSerializable(state, async (client) => {
    const parentResult = await client.query(
      `SELECT * FROM ${table(state, 'parent_heads')}
        WHERE authority_id = $1 AND parent_ref = $2 FOR UPDATE`,
      [state.authorityId, approval.parent_ref],
    );
    const parent = parentResult.rows[0];
    const parentError = parentStateError(parent, approval.parent_state_hash);
    if (parentError) throw parentError;
    if (!safeEqual(parent.governance_hash, approval.governance_hash)) {
      throw distributedAuthorityError(
        'Approval governance does not match distributed current governance',
        'DISTRIBUTED_APPROVAL_GOVERNANCE_MISMATCH',
        { parent_ref: approval.parent_ref },
      );
    }
    const existingResult = await client.query(
      `SELECT * FROM ${table(state, 'commit_approvals')}
        WHERE authority_id = $1 AND approval_key = $2 FOR UPDATE`,
      [state.authorityId, approval.approval_key],
    );
    if (existingResult.rowCount === 1) return cloneJson(existingResult.rows[0]);
    const now = await databaseNow(client);
    let inserted;
    try {
      inserted = await client.query(
        `INSERT INTO ${table(state, 'commit_approvals')} (
           authority_id, approval_key, parent_ref, status, artifact_hash,
           capsule_hash, parent_state_hash, commit_type, governance_hash,
           evidence_ref, evidence_hash, registered_at, updated_at
         ) VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9,$10,$11,$11)
         RETURNING *`,
        [
          state.authorityId,
          approval.approval_key,
          approval.parent_ref,
          approval.artifact_hash,
          approval.capsule_hash,
          approval.parent_state_hash,
          approval.commit_type,
          approval.governance_hash,
          approval.evidence_ref,
          approval.evidence_hash,
          now,
        ],
      );
    } catch (error) {
      if (error?.code === '23505') {
        throw distributedAuthorityError(
          'An active approval already exists for the exact distributed binding',
          'DISTRIBUTED_APPROVAL_CONFLICT',
          { parent_ref: approval.parent_ref, artifact_hash: approval.artifact_hash },
        );
      }
      throw error;
    }
    await appendAudit(client, state, {
      event_type: 'approval_registered',
      parent_ref: approval.parent_ref,
      observed_at: now,
      payload: {
        approval_key: approval.approval_key,
        artifact_hash: approval.artifact_hash,
        evidence_hash: approval.evidence_hash,
      },
    });
    return cloneJson(inserted.rows[0]);
  });
}

async function revokeApproval(state, input) {
  const revocation = normalizeCommitApprovalRevocation(input);
  return withSerializable(state, async (client) => {
    const parentResult = await client.query(
      `SELECT * FROM ${table(state, 'parent_heads')}
        WHERE authority_id = $1 AND parent_ref = $2 FOR UPDATE`,
      [state.authorityId, revocation.parent_ref],
    );
    const parent = parentResult.rows[0];
    const parentError = parentStateError(parent, parent?.head_hash ?? 'sha256:'.padEnd(71, '0'));
    if (parentError) throw parentError;
    const approvalResult = await client.query(
      `SELECT * FROM ${table(state, 'commit_approvals')}
        WHERE authority_id = $1 AND parent_ref = $2
          AND evidence_ref = $3 AND evidence_hash = $4
        FOR UPDATE`,
      [
        state.authorityId,
        revocation.parent_ref,
        revocation.approval_evidence_ref,
        revocation.approval_evidence_hash,
      ],
    );
    const approval = approvalResult.rows[0];
    if (!approval || approval.status !== 'active') {
      throw distributedAuthorityError(
        'The exact distributed approval is not active',
        'DISTRIBUTED_APPROVAL_NOT_ACTIVE',
        { parent_ref: revocation.parent_ref },
      );
    }
    const now = await databaseNow(client);
    const updated = await client.query(
      `UPDATE ${table(state, 'commit_approvals')}
          SET status = 'revoked', updated_at = $3,
              revocation_evidence_ref = $4, revocation_evidence_hash = $5
        WHERE authority_id = $1 AND approval_key = $2
        RETURNING *`,
      [
        state.authorityId,
        approval.approval_key,
        now,
        revocation.evidence_ref,
        revocation.evidence_hash,
      ],
    );
    await appendAudit(client, state, {
      event_type: 'approval_revoked',
      parent_ref: revocation.parent_ref,
      observed_at: now,
      payload: {
        approval_key: approval.approval_key,
        revocation_evidence_hash: revocation.evidence_hash,
      },
    });
    return cloneJson(updated.rows[0]);
  });
}

async function registerAuthorization(state, input) {
  const authorization = normalizeAuthorizationRegistration(input);
  return withSerializable(state, async (client) => {
    const existing = await client.query(
      `SELECT * FROM ${table(state, 'execution_authorizations')}
        WHERE authority_id = $1 AND authorization_id = $2 FOR UPDATE`,
      [state.authorityId, authorization.authorization_id],
    );
    if (existing.rowCount === 1) {
      const row = existing.rows[0];
      if (row.status === 'active'
        && row.authorization_ref === authorization.authorization_ref
        && safeEqual(row.authorization_hash, authorization.authorization_hash)
        && safeEqual(row.binding_hash, authorization.binding_hash)
        && asIso(row.expires_at, 'stored authorization expiry') === authorization.expires_at) {
        return cloneJson(row);
      }
      throw distributedAuthorityError(
        'Distributed authorization is already registered differently',
        'DISTRIBUTED_AUTHORIZATION_REGISTRATION_CONFLICT',
        { authorization_id: authorization.authorization_id },
      );
    }
    const now = await databaseNow(client);
    const inserted = await client.query(
      `INSERT INTO ${table(state, 'execution_authorizations')} (
         authority_id, authorization_id, status, authorization_ref,
         authorization_hash, binding_hash, expires_at, evidence_ref,
         evidence_hash, registered_at, updated_at
       ) VALUES ($1,$2,'active',$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING *`,
      [
        state.authorityId,
        authorization.authorization_id,
        authorization.authorization_ref,
        authorization.authorization_hash,
        authorization.binding_hash,
        authorization.expires_at,
        authorization.evidence_ref,
        authorization.evidence_hash,
        now,
      ],
    );
    await appendAudit(client, state, {
      event_type: 'authorization_registered',
      authorization_id: authorization.authorization_id,
      observed_at: now,
      payload: {
        binding_hash: authorization.binding_hash,
        expires_at: authorization.expires_at,
        evidence_hash: authorization.evidence_hash,
      },
    });
    return cloneJson(inserted.rows[0]);
  });
}

async function revokeAuthorization(state, input) {
  const revocation = normalizeAuthorizationRevocation(input);
  return withSerializable(state, async (client) => {
    const result = await client.query(
      `SELECT * FROM ${table(state, 'execution_authorizations')}
        WHERE authority_id = $1 AND authorization_id = $2 FOR UPDATE`,
      [state.authorityId, revocation.authorization_id],
    );
    const authorization = result.rows[0];
    const stateError = authorizationStateError(authorization, revocation.authorization_id);
    if (stateError) throw stateError;
    const now = await databaseNow(client);
    const updated = await client.query(
      `UPDATE ${table(state, 'execution_authorizations')}
          SET status = 'revoked', updated_at = $3,
              revocation_evidence_ref = $4, revocation_evidence_hash = $5
        WHERE authority_id = $1 AND authorization_id = $2
        RETURNING *`,
      [
        state.authorityId,
        revocation.authorization_id,
        now,
        revocation.evidence_ref,
        revocation.evidence_hash,
      ],
    );
    await appendAudit(client, state, {
      event_type: 'authorization_revoked',
      authorization_id: revocation.authorization_id,
      observed_at: now,
      payload: { revocation_evidence_hash: revocation.evidence_hash },
    });
    return cloneJson(updated.rows[0]);
  });
}

function exactApprovalMatches(approval, request) {
  return approval
    && approval.status === 'active'
    && safeEqual(approval.artifact_hash, request.artifact_hash)
    && safeEqual(approval.capsule_hash, request.capsule_hash)
    && safeEqual(approval.parent_state_hash, request.expected_parent_head_hash)
    && approval.commit_type === request.commit_type
    && safeEqual(approval.governance_hash, request.governance_hash)
    && approval.evidence_ref === request.approval_evidence_ref
    && safeEqual(approval.evidence_hash, request.approval_evidence_hash);
}

function assertBindingGovernanceMatches(currentGovernance, authorization) {
  const binding = authorization.binding.governance;
  const comparisons = [
    ['policy_ref', binding.policy_ref, currentGovernance.policy.ref],
    ['policy_version', binding.policy_version, currentGovernance.policy.version],
    ['policy_hash', binding.policy_hash, currentGovernance.policy.hash],
    ['mandate_ref', binding.mandate_ref, currentGovernance.mandate?.ref ?? null],
    ['mandate_version', binding.mandate_version, currentGovernance.mandate?.version ?? null],
    ['mandate_hash', binding.mandate_hash, currentGovernance.mandate?.hash ?? null],
    ['budget_policy_ref', binding.budget_policy_ref, currentGovernance.budget_policy?.ref ?? null],
    ['budget_version', binding.budget_version, currentGovernance.budget_policy?.version ?? null],
    ['budget_hash', binding.budget_hash, currentGovernance.budget_policy?.hash ?? null],
    ['epoch', binding.epoch, currentGovernance.epoch],
    [
      'governance_evidence_ref',
      authorization.governance_evidence_ref,
      currentGovernance.evidence_ref,
    ],
    [
      'governance_evidence_hash',
      authorization.governance_evidence_hash,
      currentGovernance.evidence_hash,
    ],
  ];
  const mismatch = comparisons.find(([, observed, expected]) => (
    typeof expected === 'string' && expected.startsWith('sha256:')
      ? !safeEqual(observed, expected)
      : observed !== expected
  ));
  if (mismatch) {
    throw distributedAuthorityError(
      'Execution binding governance differs from distributed current governance',
      'DISTRIBUTED_AUTHORIZATION_GOVERNANCE_MISMATCH',
      { authorization_id: authorization.authorization_id, field: mismatch[0] },
    );
  }
}

async function prepareOperation(state, request, verifyUnderReservation) {
  return withSerializable(state, async (client) => {
    const existing = await client.query(
      `SELECT * FROM ${table(state, 'operations')}
        WHERE authority_id = $1 AND request_hash = $2`,
      [state.authorityId, request.request_hash],
    );
    if (existing.rowCount === 1) {
      const operation = operationFromRow(existing.rows[0], { idempotent: true });
      if (operation.status === 'committed') return { operation, alreadyCommitted: true };
      if (operation.status === 'prepared') return { operation, alreadyCommitted: false };
      if (['effect_started', 'ambiguous'].includes(operation.status)) {
        throw new DistributedAuthorityAmbiguousError(
          'The exact distributed request has an unresolved effect',
          { operation_ref: operation.operation_ref, status: operation.status, version: operation.version },
        );
      }
      throw distributedAuthorityError(
        'The exact distributed request is terminal and cannot be replayed',
        'DISTRIBUTED_REQUEST_TERMINAL',
        { operation_ref: operation.operation_ref, status: operation.status },
      );
    }

    const parentResult = await client.query(
      `SELECT * FROM ${table(state, 'parent_heads')}
        WHERE authority_id = $1 AND parent_ref = $2 FOR UPDATE`,
      [state.authorityId, request.parent_ref],
    );
    const parent = parentResult.rows[0];
    const parentError = parentStateError(parent, request.expected_parent_head_hash);
    if (parentError) throw parentError;
    if (!safeEqual(parent.governance_hash, request.governance_hash)
      || parent.current_governance == null
      || !safeEqual(sha256Ref(parent.current_governance), request.governance_hash)) {
      throw distributedAuthorityError(
        'Distributed current governance differs from the exact clean request',
        'DISTRIBUTED_GOVERNANCE_STALE',
        { parent_ref: request.parent_ref, governance_hash: request.governance_hash },
      );
    }

    const approvalResult = await client.query(
      `SELECT * FROM ${table(state, 'commit_approvals')}
        WHERE authority_id = $1 AND parent_ref = $2
          AND evidence_ref = $3 AND evidence_hash = $4
        FOR UPDATE`,
      [
        state.authorityId,
        request.parent_ref,
        request.approval_evidence_ref,
        request.approval_evidence_hash,
      ],
    );
    const approval = approvalResult.rows[0];
    if (!exactApprovalMatches(approval, request)) {
      throw distributedAuthorityError(
        'The exact distributed clean approval is not active',
        'DISTRIBUTED_APPROVAL_NOT_ACTIVE',
        { parent_ref: request.parent_ref, artifact_hash: request.artifact_hash },
      );
    }

    let authorization = null;
    let authorizationVerification = null;
    let observedAt = await databaseNow(client);
    if (Date.parse(request.capsule_expires_at) <= Date.parse(observedAt)) {
      throw distributedAuthorityError(
        'The Savepoint Capsule expired before distributed reservation',
        'DISTRIBUTED_CAPSULE_EXPIRED',
        { observed_at: observedAt, capsule_expires_at: request.capsule_expires_at },
      );
    }
    if (request.authorization) {
      const authorizationResult = await client.query(
        `SELECT * FROM ${table(state, 'execution_authorizations')}
          WHERE authority_id = $1 AND authorization_id = $2 FOR UPDATE`,
        [state.authorityId, request.authorization.authorization_id],
      );
      authorization = authorizationResult.rows[0];
      const stateError = authorizationStateError(
        authorization,
        request.authorization.authorization_id,
      );
      if (stateError) throw stateError;
      for (const [field, expected] of [
        ['authorization_ref', request.authorization.authorization_ref],
        ['authorization_hash', request.authorization.authorization_hash],
        ['binding_hash', request.authorization.binding_hash],
      ]) {
        if (!safeEqual(authorization[field], expected)) {
          throw distributedAuthorityError(
            `Distributed authorization does not match ${field}`,
            'DISTRIBUTED_AUTHORIZATION_BINDING_MISMATCH',
            { authorization_id: authorization.authorization_id, field },
          );
        }
      }
      if (Date.parse(asIso(authorization.expires_at, 'authorization expires_at'))
        <= Date.parse(observedAt)) {
        throw distributedAuthorityError(
          'Distributed execution authorization is expired',
          'DISTRIBUTED_AUTHORIZATION_EXPIRED',
          { authorization_id: authorization.authorization_id, observed_at: observedAt },
        );
      }
      verifyExecutionBinding(request.authorization.binding, {
        one_use_authorization_id: authorization.authorization_id,
        authorization_ref: authorization.authorization_ref,
        authorization_hash: authorization.authorization_hash,
      }, { now: observedAt });
      assertBindingGovernanceMatches(parent.current_governance, request.authorization);
      if (typeof state.verifyAuthorizationIntegrity !== 'function') {
        throw distributedAuthorityError(
          'Distributed consequential execution requires a trusted integrity verifier',
          'DISTRIBUTED_AUTHORIZATION_VERIFIER_REQUIRED',
          { authorization_id: authorization.authorization_id },
        );
      }
      const verificationRequest = buildAuthorizationVerificationRequest(
        authorization,
        request.authorization,
        observedAt,
      );
      const authorizationObservedAt = observedAt;
      authorizationVerification = verifyAuthorizationVerification(
        await runBoundedVerification(
          state,
          state.verifyAuthorizationIntegrity,
          deepFreeze(cloneJson(verificationRequest)),
          'authorization integrity verification',
        ),
        verificationRequest,
      );
      observedAt = await databaseNow(client);
      assertDatabaseTimeNotBefore(observedAt, null, { updated_at: authorizationObservedAt });
      if (Date.parse(request.capsule_expires_at) <= Date.parse(observedAt)
        || Date.parse(asIso(authorization.expires_at, 'authorization expires_at'))
          <= Date.parse(observedAt)) {
        throw distributedAuthorityError(
          'Distributed commit validity expired during authorization verification',
          'DISTRIBUTED_AUTHORITY_EXPIRED_DURING_VERIFICATION',
          { authorization_id: authorization.authorization_id, observed_at: observedAt },
        );
      }
    }

    const gateRequest = deepFreeze({
      schema: 'agoragentic.risk-fork.distributed-final-gate-request.v1',
      request_hash: request.request_hash,
      authority_request_hash: request.authority_request_hash,
      parent_ref: request.parent_ref,
      expected_parent_head_hash: request.expected_parent_head_hash,
      artifact_hash: request.artifact_hash,
      capsule_hash: request.capsule_hash,
      governance: cloneJson(parent.current_governance),
      governance_hash: request.governance_hash,
      approval_evidence_ref: approval.evidence_ref,
      approval_evidence_hash: approval.evidence_hash,
      authorization_binding_hash: request.authorization?.binding_hash ?? null,
      observed_at: observedAt,
    });
    const gateObservedAt = observedAt;
    const gateResult = await runBoundedVerification(
      state,
      verifyUnderReservation,
      gateRequest,
      'clean final gate verification',
    );
    assertPlainObject(gateResult, 'distributed final gate result');
    assertAllowedKeys(gateResult, [
      'schema',
      'status',
      'request_hash',
      'authority_request_hash',
      'governance_hash',
    ], 'distributed final gate result');
    if (gateResult.schema !== 'agoragentic.risk-fork.distributed-final-gate-verification.v1'
      || gateResult.status !== 'verified'
      || !safeEqual(gateResult.request_hash, request.request_hash)
      || !safeEqual(gateResult.authority_request_hash, request.authority_request_hash)
      || !safeEqual(gateResult.governance_hash, request.governance_hash)) {
      throw distributedAuthorityError(
        'Clean final gate did not verify the exact distributed reservation',
        'DISTRIBUTED_FINAL_GATE_NOT_VERIFIED',
        { request_hash: request.request_hash },
      );
    }
    observedAt = await databaseNow(client);
    assertDatabaseTimeNotBefore(
      observedAt,
      null,
      parent,
      approval,
      authorization,
      { updated_at: gateObservedAt },
    );
    if (Date.parse(request.capsule_expires_at) <= Date.parse(observedAt)
      || (authorization
        && Date.parse(asIso(authorization.expires_at, 'authorization expires_at'))
          <= Date.parse(observedAt))) {
      throw distributedAuthorityError(
        'Distributed commit validity expired during the final clean gate',
        'DISTRIBUTED_AUTHORITY_EXPIRED_DURING_FINAL_GATE',
        { observed_at: observedAt },
      );
    }

    const operationRef = `distributed-operation:${randomUUID()}`;
    const inserted = await client.query(
      `INSERT INTO ${table(state, 'operations')} (
         authority_id, operation_ref, request_hash, authority_request_hash,
         parent_ref, approval_key, authorization_id, status, commit_type,
         previous_head_hash, artifact_hash, capsule_hash, governance_hash,
         governance_evidence_hash, approval_evidence_ref,
         approval_evidence_hash, authorization_binding_hash,
         capsule_expires_at, version, prepared_at, updated_at
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,'prepared',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,1,$18,$18
       ) RETURNING *`,
      [
        state.authorityId,
        operationRef,
        request.request_hash,
        request.authority_request_hash,
        request.parent_ref,
        approval.approval_key,
        authorization?.authorization_id ?? null,
        request.commit_type,
        request.expected_parent_head_hash,
        request.artifact_hash,
        request.capsule_hash,
        request.governance_hash,
        parent.current_governance.evidence_hash,
        approval.evidence_ref,
        approval.evidence_hash,
        request.authorization?.binding_hash ?? null,
        request.capsule_expires_at,
        observedAt,
      ],
    );
    await client.query(
      `UPDATE ${table(state, 'parent_heads')}
          SET status = 'reserved', pending_operation_ref = $3,
              version = version + 1, updated_at = $4
        WHERE authority_id = $1 AND parent_ref = $2`,
      [state.authorityId, request.parent_ref, operationRef, observedAt],
    );
    await client.query(
      `UPDATE ${table(state, 'commit_approvals')}
          SET status = 'reserved', operation_ref = $3, updated_at = $4
        WHERE authority_id = $1 AND approval_key = $2`,
      [state.authorityId, approval.approval_key, operationRef, observedAt],
    );
    if (authorization) {
      await client.query(
        `UPDATE ${table(state, 'execution_authorizations')}
            SET status = 'reserved', operation_ref = $3,
                verification_evidence_ref = $4,
                verification_evidence_hash = $5, updated_at = $6
          WHERE authority_id = $1 AND authorization_id = $2`,
        [
          state.authorityId,
          authorization.authorization_id,
          operationRef,
          authorizationVerification.evidence_ref,
          authorizationVerification.evidence_hash,
          observedAt,
        ],
      );
    }
    const audit = await appendAudit(client, state, {
      event_type: 'commit_prepared',
      operation_ref: operationRef,
      parent_ref: request.parent_ref,
      authorization_id: authorization?.authorization_id ?? null,
      observed_at: observedAt,
      payload: {
        request_hash: request.request_hash,
        authority_request_hash: request.authority_request_hash,
        artifact_hash: request.artifact_hash,
        governance_hash: request.governance_hash,
        approval_key: approval.approval_key,
        authorization_binding_hash: request.authorization?.binding_hash ?? null,
        gate_hash: sha256Ref(gateResult),
      },
    });
    return {
      operation: operationFromRow(inserted.rows[0]),
      alreadyCommitted: false,
      governance: cloneJson(parent.current_governance),
      audit,
    };
  });
}

async function startEffect(state, input) {
  const request = normalizeEffectStartRequest(input);
  return withSerializable(state, async (client) => {
    const graph = await lockOperationGraph(client, state, request.operation_ref);
    const operation = graph.operation;
    if (operation.status !== 'prepared' || asVersion(operation.version) !== request.expected_version) {
      if (['effect_started', 'ambiguous'].includes(operation.status)) {
        throw new DistributedAuthorityAmbiguousError(
          'Distributed effect was already claimed; automatic invocation is forbidden',
          { operation_ref: operation.operation_ref, status: operation.status, version: asVersion(operation.version) },
        );
      }
      throw distributedAuthorityError(
        'Distributed operation is not at the exact prepared version',
        'DISTRIBUTED_OPERATION_VERSION_CONFLICT',
        { operation_ref: operation.operation_ref, status: operation.status, version: asVersion(operation.version) },
      );
    }
    assertLockedReservation(graph);
    const observedAt = await databaseNow(client);
    assertDatabaseTimeNotBefore(
      observedAt,
      operation.operation_ref,
      operation,
      graph.parent,
      graph.approval,
      graph.authorization,
    );
    if (Date.parse(asIso(operation.capsule_expires_at, 'capsule_expires_at'))
      <= Date.parse(observedAt)) {
      throw distributedAuthorityError(
        'Savepoint Capsule expired before the durable effect claim',
        'DISTRIBUTED_CAPSULE_EXPIRED',
        { operation_ref: operation.operation_ref, observed_at: observedAt },
      );
    }
    if (graph.authorization
      && Date.parse(asIso(graph.authorization.expires_at, 'authorization expires_at'))
        <= Date.parse(observedAt)) {
      throw distributedAuthorityError(
        'Execution authorization expired before the durable effect claim',
        'DISTRIBUTED_AUTHORIZATION_EXPIRED',
        { operation_ref: operation.operation_ref, observed_at: observedAt },
      );
    }
    const effectToken = `effect-token:${randomBytes(32).toString('hex')}`;
    const effectTokenHash = sha256Ref(effectToken);
    const effectKey = `risk-fork-effect:${sha256Ref({
      authority_id: state.authorityId,
      operation_ref: operation.operation_ref,
      request_hash: operation.request_hash,
    }).slice(7)}`;
    const updated = await client.query(
      `UPDATE ${table(state, 'operations')}
          SET status = 'effect_started', effect_key = $3,
              effect_token_hash = $4, claimant_ref = $5,
              effect_started_at = $6, updated_at = $6, version = version + 1
        WHERE authority_id = $1 AND operation_ref = $2
        RETURNING *`,
      [
        state.authorityId,
        operation.operation_ref,
        effectKey,
        effectTokenHash,
        request.claimant_ref,
        observedAt,
      ],
    );
    if (graph.authorization) {
      await client.query(
        `UPDATE ${table(state, 'execution_authorizations')}
            SET status = 'effect_started', updated_at = $3
          WHERE authority_id = $1 AND authorization_id = $2`,
        [state.authorityId, graph.authorization.authorization_id, observedAt],
      );
    }
    const audit = await appendAudit(client, state, {
      event_type: 'effect_started',
      operation_ref: operation.operation_ref,
      parent_ref: operation.parent_ref,
      authorization_id: operation.authorization_id,
      observed_at: observedAt,
      payload: {
        effect_key: effectKey,
        effect_token_hash: effectTokenHash,
        claimant_ref: request.claimant_ref,
      },
    });
    return {
      operation: operationFromRow(updated.rows[0]),
      effect_token: effectToken,
      effect_key: effectKey,
      audit,
    };
  });
}

function finalHashes(operation, result, completedAt) {
  const resultHash = sha256Ref(result);
  const nextHeadHash = sha256Ref({
    previous_head_hash: operation.previous_head_hash,
    artifact_hash: operation.artifact_hash,
    result_hash: resultHash,
    governance_evidence_hash: operation.governance_evidence_hash,
  });
  const transactionHash = sha256Ref({
    schema: 'agoragentic.risk-fork.distributed-transaction.v1',
    operation_ref: operation.operation_ref,
    request_hash: operation.request_hash,
    authority_request_hash: operation.authority_request_hash,
    effect_key: operation.effect_key,
    previous_head_hash: operation.previous_head_hash,
    next_head_hash: nextHeadHash,
    result_hash: resultHash,
    completed_at: completedAt,
  });
  return { resultHash, nextHeadHash, transactionHash };
}

async function finalizeLocked(client, state, graph, result, reconciliation = null) {
  const completedAt = await databaseNow(client);
  assertDatabaseTimeNotBefore(
    completedAt,
    graph.operation.operation_ref,
    graph.operation,
    graph.parent,
    graph.approval,
    graph.authorization,
  );
  const hashes = finalHashes(graph.operation, result, completedAt);
  const updated = await client.query(
    `UPDATE ${table(state, 'operations')}
        SET status = 'committed', result = $3::jsonb, result_hash = $4,
            next_head_hash = $5, transaction_hash = $6,
            resolution = $7, resolution_evidence_ref = $8,
            resolution_evidence_hash = $9, completed_at = $10,
            updated_at = $10, version = version + 1
      WHERE authority_id = $1 AND operation_ref = $2
      RETURNING *`,
    [
      state.authorityId,
      graph.operation.operation_ref,
      JSON.stringify(result),
      hashes.resultHash,
      hashes.nextHeadHash,
      hashes.transactionHash,
      reconciliation?.resolution ?? null,
      reconciliation?.evidence_ref ?? null,
      reconciliation?.evidence_hash ?? null,
      completedAt,
    ],
  );
  await client.query(
    `UPDATE ${table(state, 'parent_heads')}
        SET status = 'active', head_hash = $3, pending_operation_ref = NULL,
            version = version + 1, updated_at = $4
      WHERE authority_id = $1 AND parent_ref = $2`,
    [state.authorityId, graph.operation.parent_ref, hashes.nextHeadHash, completedAt],
  );
  await client.query(
    `UPDATE ${table(state, 'commit_approvals')}
        SET status = 'consumed', consumed_at = $3, updated_at = $3
      WHERE authority_id = $1 AND approval_key = $2`,
    [state.authorityId, graph.operation.approval_key, completedAt],
  );
  if (graph.authorization) {
    await client.query(
      `UPDATE ${table(state, 'execution_authorizations')}
          SET status = 'consumed', result_hash = $3, consumed_at = $4,
              failure_code = NULL, updated_at = $4
        WHERE authority_id = $1 AND authorization_id = $2`,
      [state.authorityId, graph.authorization.authorization_id, hashes.resultHash, completedAt],
    );
  }
  const audit = await appendAudit(client, state, {
    event_type: reconciliation ? 'commit_reconciled_succeeded' : 'commit_finalized',
    operation_ref: graph.operation.operation_ref,
    parent_ref: graph.operation.parent_ref,
    authorization_id: graph.operation.authorization_id,
    observed_at: completedAt,
    payload: {
      result_hash: hashes.resultHash,
      next_head_hash: hashes.nextHeadHash,
      transaction_hash: hashes.transactionHash,
      resolution_evidence_hash: reconciliation?.evidence_hash ?? null,
      outcome_evidence_hash: reconciliation?.outcome_evidence_hash ?? null,
      reconciliation_request_hash: reconciliation?.verification_request_hash ?? null,
      requested_by_hash: reconciliation?.requested_by_hash ?? null,
    },
  });
  return { operation: operationFromRow(updated.rows[0]), audit };
}

async function finalizeEffect(state, input) {
  const request = normalizeFinalizationRequest(input);
  return withSerializable(state, async (client) => {
    const graph = await lockOperationGraph(client, state, request.operation_ref);
    const operation = graph.operation;
    if (operation.status === 'committed') {
      if (safeEqual(operation.result_hash, request.result_hash)
        && safeEqual(operation.effect_token_hash, sha256Ref(request.effect_token))) {
        return { operation: operationFromRow(operation, { idempotent: true }), audit: null };
      }
      throw distributedAuthorityError(
        'Committed distributed result differs from finalization retry',
        'DISTRIBUTED_FINALIZATION_CONFLICT',
        { operation_ref: operation.operation_ref },
      );
    }
    if (operation.status !== 'effect_started'
      || asVersion(operation.version) !== request.expected_version
      || !safeEqual(operation.effect_token_hash, sha256Ref(request.effect_token))) {
      throw new DistributedAuthorityAmbiguousError(
        'Distributed effect cannot be finalized from the observed state',
        { operation_ref: operation.operation_ref, status: operation.status, version: asVersion(operation.version) },
      );
    }
    assertLockedReservation(graph);
    return finalizeLocked(client, state, graph, request.result);
  });
}

async function markAmbiguous(state, input) {
  const request = normalizeAmbiguityRequest(input);
  return withSerializable(state, async (client) => {
    const graph = await lockOperationGraph(client, state, request.operation_ref);
    const operation = graph.operation;
    if (operation.status === 'ambiguous') return operationFromRow(operation, { idempotent: true });
    if (operation.status === 'committed') return operationFromRow(operation, { idempotent: true });
    if (operation.status !== 'effect_started'
      || asVersion(operation.version) !== request.expected_version
      || !safeEqual(operation.effect_token_hash, sha256Ref(request.effect_token))) {
      throw new DistributedAuthorityAmbiguousError(
        'Distributed effect state changed before ambiguity could be recorded',
        { operation_ref: operation.operation_ref, status: operation.status, version: asVersion(operation.version) },
      );
    }
    assertLockedReservation(graph);
    const now = await databaseNow(client);
    assertDatabaseTimeNotBefore(
      now,
      operation.operation_ref,
      operation,
      graph.parent,
      graph.approval,
      graph.authorization,
    );
    const updated = await client.query(
      `UPDATE ${table(state, 'operations')}
          SET status = 'ambiguous', failure_code = $3, failure_message = $4,
              updated_at = $5, version = version + 1
        WHERE authority_id = $1 AND operation_ref = $2
        RETURNING *`,
      [
        state.authorityId,
        operation.operation_ref,
        request.failure_code,
        request.failure_message,
        now,
      ],
    );
    await client.query(
      `UPDATE ${table(state, 'parent_heads')}
          SET status = 'ambiguous', version = version + 1, updated_at = $3
        WHERE authority_id = $1 AND parent_ref = $2`,
      [state.authorityId, operation.parent_ref, now],
    );
    if (graph.authorization) {
      await client.query(
        `UPDATE ${table(state, 'execution_authorizations')}
            SET status = 'ambiguous', failure_code = $3, updated_at = $4
          WHERE authority_id = $1 AND authorization_id = $2`,
        [state.authorityId, graph.authorization.authorization_id, request.failure_code, now],
      );
    }
    await appendAudit(client, state, {
      event_type: 'effect_ambiguous',
      operation_ref: operation.operation_ref,
      parent_ref: operation.parent_ref,
      authorization_id: operation.authorization_id,
      observed_at: now,
      payload: {
        failure_code: request.failure_code,
        failure_message_hash: sha256Ref(request.failure_message),
      },
    });
    return operationFromRow(updated.rows[0]);
  });
}

async function recoverPrepared(state, input) {
  const request = normalizePreparedRecoveryRequest(input);
  return withSerializable(state, async (client) => {
    const graph = await lockOperationGraph(client, state, request.operation_ref);
    const operation = graph.operation;
    if (operation.status === 'aborted') return operationFromRow(operation, { idempotent: true });
    if (operation.status !== 'prepared' || asVersion(operation.version) !== request.expected_version) {
      throw new DistributedAuthorityAmbiguousError(
        'Only an exact pre-effect prepared operation can be safely recovered',
        { operation_ref: operation.operation_ref, status: operation.status, version: asVersion(operation.version) },
      );
    }
    assertLockedReservation(graph);
    const now = await databaseNow(client);
    assertDatabaseTimeNotBefore(
      now,
      operation.operation_ref,
      operation,
      graph.parent,
      graph.approval,
      graph.authorization,
    );
    const updated = await client.query(
      `UPDATE ${table(state, 'operations')}
          SET status = 'aborted', completed_at = $3, updated_at = $3,
              resolution_evidence_ref = $4, resolution_evidence_hash = $5,
              version = version + 1
        WHERE authority_id = $1 AND operation_ref = $2
        RETURNING *`,
      [
        state.authorityId,
        operation.operation_ref,
        now,
        request.recovery_evidence_ref,
        request.recovery_evidence_hash,
      ],
    );
    await client.query(
      `UPDATE ${table(state, 'parent_heads')}
          SET status = 'active', pending_operation_ref = NULL,
              version = version + 1, updated_at = $3
        WHERE authority_id = $1 AND parent_ref = $2`,
      [state.authorityId, operation.parent_ref, now],
    );
    await client.query(
      `UPDATE ${table(state, 'commit_approvals')}
          SET status = 'active', operation_ref = NULL, updated_at = $3
        WHERE authority_id = $1 AND approval_key = $2`,
      [state.authorityId, operation.approval_key, now],
    );
    if (graph.authorization) {
      await client.query(
        `UPDATE ${table(state, 'execution_authorizations')}
            SET status = 'active', operation_ref = NULL,
                verification_evidence_ref = NULL,
                verification_evidence_hash = NULL, updated_at = $3
          WHERE authority_id = $1 AND authorization_id = $2`,
        [state.authorityId, graph.authorization.authorization_id, now],
      );
    }
    await appendAudit(client, state, {
      event_type: 'prepared_operation_recovered',
      operation_ref: operation.operation_ref,
      parent_ref: operation.parent_ref,
      authorization_id: operation.authorization_id,
      observed_at: now,
      payload: { recovery_evidence_hash: request.recovery_evidence_hash },
    });
    return operationFromRow(updated.rows[0]);
  });
}

async function reconcile(state, input) {
  const request = normalizeReconciliationInput(input);
  if (typeof state.verifyReconciliation !== 'function') {
    throw distributedAuthorityError(
      'Distributed reconciliation requires a trusted outcome verifier',
      'DISTRIBUTED_RECONCILIATION_VERIFIER_REQUIRED',
      { operation_ref: request.operation_ref },
    );
  }
  return withSerializable(state, async (client) => {
    const graph = await lockOperationGraph(client, state, request.operation_ref);
    const operation = graph.operation;
    if (!['effect_started', 'ambiguous'].includes(operation.status)
      || asVersion(operation.version) !== request.expected_version) {
      throw distributedAuthorityError(
        'Distributed reconciliation requires the exact unresolved operation version',
        'DISTRIBUTED_RECONCILIATION_VERSION_CONFLICT',
        { operation_ref: operation.operation_ref, status: operation.status, version: asVersion(operation.version) },
      );
    }
    assertLockedReservation(graph);
    const observedAt = await databaseNow(client);
    assertDatabaseTimeNotBefore(
      observedAt,
      operation.operation_ref,
      operation,
      graph.parent,
      graph.approval,
      graph.authorization,
    );
    const normalizedOperation = operationFromRow(operation);
    const verificationRequest = buildReconciliationVerificationRequest(
      normalizedOperation,
      request,
      observedAt,
    );
    const verification = verifyReconciliationVerification(
      await runBoundedVerification(
        state,
        state.verifyReconciliation,
        deepFreeze(cloneJson(verificationRequest)),
        'outcome reconciliation verification',
      ),
      verificationRequest,
    );
    const finalObservedAt = await databaseNow(client);
    if (Date.parse(finalObservedAt) < Date.parse(observedAt)) {
      throw distributedAuthorityError(
        'PostgreSQL authority time moved backward during reconciliation',
        'DISTRIBUTED_AUTHORITY_CLOCK_ROLLBACK',
        { operation_ref: operation.operation_ref, observed_at: observedAt, final_observed_at: finalObservedAt },
      );
    }
    if (request.resolution === 'effect_succeeded') {
      return finalizeLocked(client, state, graph, request.result, {
        resolution: request.resolution,
        requested_by_hash: sha256Ref(request.requested_by),
        outcome_evidence_hash: request.outcome_evidence_hash,
        verification_request_hash: verificationRequest.verification_request_hash,
        ...verification,
      });
    }

    // A non-success observation is only point-in-time evidence. The original
    // claimant may still be running (or its downstream acknowledgement may be
    // delayed), so releasing the parent, approval, or one-use authorization
    // here would permit a second effect while the first can still complete.
    // Only an exact proven success may cross the post-effect-start boundary.
    const failureCode = request.resolution === 'effect_absent'
      ? 'RECONCILIATION_EFFECT_ABSENT_UNSAFE_TO_RELEASE'
      : 'RECONCILIATION_EFFECT_FAILED_UNSAFE_TO_RELEASE';
    const failureMessage = request.resolution === 'effect_absent'
      ? 'verified_point_in_time_absence_does_not_fence_the_original_effect'
      : 'verified_terminal_failure_does_not_prove_the_original_effect_cannot_complete';
    const updated = await client.query(
      `UPDATE ${table(state, 'operations')}
          SET status = 'ambiguous', failure_code = $3, failure_message = $4,
              updated_at = $5, version = version + 1
        WHERE authority_id = $1 AND operation_ref = $2
        RETURNING *`,
      [
        state.authorityId,
        operation.operation_ref,
        failureCode,
        failureMessage,
        finalObservedAt,
      ],
    );
    await client.query(
      `UPDATE ${table(state, 'parent_heads')}
          SET status = 'ambiguous',
              version = version + 1, updated_at = $3
        WHERE authority_id = $1 AND parent_ref = $2`,
      [state.authorityId, operation.parent_ref, finalObservedAt],
    );
    if (graph.authorization) {
      await client.query(
        `UPDATE ${table(state, 'execution_authorizations')}
            SET status = 'ambiguous', failure_code = $3, updated_at = $4
          WHERE authority_id = $1 AND authorization_id = $2`,
        [
          state.authorityId,
          graph.authorization.authorization_id,
          failureCode,
          finalObservedAt,
        ],
      );
    }
    const audit = await appendAudit(client, state, {
      event_type: 'reconciliation_kept_ambiguous',
      operation_ref: operation.operation_ref,
      parent_ref: operation.parent_ref,
      authorization_id: operation.authorization_id,
      observed_at: finalObservedAt,
      payload: {
        resolution: request.resolution,
        result_hash: request.result_hash,
        failure_code: failureCode,
        resolution_evidence_hash: verification.evidence_hash,
        outcome_evidence_hash: request.outcome_evidence_hash,
        reconciliation_request_hash: verificationRequest.verification_request_hash,
        requested_by_hash: sha256Ref(request.requested_by),
      },
    });
    return { operation: operationFromRow(updated.rows[0]), audit };
  });
}

async function getOperation(state, operationRef) {
  const normalized = requireOpaqueRef(operationRef, 'operation_ref');
  const result = await state.pool.query(
    `SELECT * FROM ${table(state, 'operations')}
      WHERE authority_id = $1 AND operation_ref = $2`,
    [state.authorityId, normalized],
  );
  return operationFromRow(result.rows[0] ?? null);
}

async function listUnresolved(state, input = {}) {
  assertPlainObject(input, 'distributed unresolved query');
  assertAllowedKeys(input, ['limit', 'before', 'cursor'], 'distributed unresolved query');
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('unresolved query limit must be between 1 and 1000');
  }
  const before = input.before == null ? null : requireIsoDate(input.before, 'unresolved query before');
  const cursor = input.cursor == null ? null : requireOpaqueRef(input.cursor, 'unresolved query cursor');
  const result = await state.pool.query(
    `SELECT * FROM ${table(state, 'operations')}
      WHERE authority_id = $1
        AND status IN ('prepared', 'effect_started', 'ambiguous')
        AND ($2::timestamptz IS NULL OR updated_at < $2::timestamptz)
        AND ($3::text IS NULL OR operation_ref > $3::text)
      ORDER BY operation_ref ASC
      LIMIT $4`,
    [state.authorityId, before, cursor, limit],
  );
  return deepFreeze({
    operations: result.rows.map((row) => operationFromRow(row)),
    next_cursor: result.rowCount === limit ? result.rows.at(-1).operation_ref : null,
  });
}

async function getAuditTrail(state, input = {}) {
  assertPlainObject(input, 'distributed audit query');
  assertAllowedKeys(input, ['after_sequence', 'limit'], 'distributed audit query');
  const after = input.after_sequence ?? 0;
  const limit = input.limit ?? 1000;
  if (!Number.isSafeInteger(after) || after < 0
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TypeError('distributed audit pagination is invalid');
  }
  const result = await state.pool.query(
    `SELECT * FROM ${table(state, 'audit_events')}
      WHERE authority_id = $1 AND sequence > $2
      ORDER BY sequence ASC LIMIT $3`,
    [state.authorityId, after, limit],
  );
  let previous = after === 0 ? null : null;
  if (after > 0) {
    const head = await state.pool.query(
      `SELECT event_hash FROM ${table(state, 'audit_events')}
        WHERE authority_id = $1 AND sequence = $2`,
      [state.authorityId, after],
    );
    if (head.rowCount !== 1) throw new Error('Audit pagination predecessor is absent');
    previous = head.rows[0].event_hash;
  }
  const events = [];
  let expectedSequence = after + 1;
  for (const row of result.rows) {
    const sequence = Number.parseInt(row.sequence, 10);
    const observedAt = asIso(row.observed_at, 'audit observed_at');
    const payload = cloneJson(row.payload);
    const payloadHash = sha256Ref(payload);
    const body = {
      schema: 'agoragentic.risk-fork.distributed-authority-audit-event.v1',
      authority_id: state.authorityId,
      sequence,
      event_type: row.event_type,
      operation_ref: row.operation_ref ?? null,
      parent_ref: row.parent_ref ?? null,
      authorization_id: row.authorization_id ?? null,
      observed_at: observedAt,
      previous_event_hash: row.previous_event_hash ?? null,
      payload_hash: payloadHash,
    };
    if (sequence !== expectedSequence
      || !safeEqual(row.payload_hash, payloadHash)
      || row.previous_event_hash !== previous
      || !safeEqual(row.event_hash, sha256Ref(body))) {
      throw distributedAuthorityError(
        'Distributed authority audit chain verification failed',
        'DISTRIBUTED_AUDIT_CHAIN_INVALID',
        { sequence },
      );
    }
    events.push(deepFreeze({ ...body, payload, event_hash: row.event_hash }));
    previous = row.event_hash;
    expectedSequence += 1;
  }
  return deepFreeze({
    events,
    next_sequence: events.length === limit ? events.at(-1).sequence : null,
    verified: true,
  });
}

async function runCommit(state, input, callbacks) {
  const request = normalizeDistributedPrepareRequest(input);
  assertPlainObject(callbacks, 'distributed commit callbacks');
  assertAllowedKeys(
    callbacks,
    ['verifyUnderReservation', 'performEffect', 'claimant_ref'],
    'distributed commit callbacks',
  );
  if (typeof callbacks.verifyUnderReservation !== 'function'
    || typeof callbacks.performEffect !== 'function') {
    throw new TypeError('Distributed commit requires exact clean-gate and effect callbacks');
  }
  const claimantRef = requireOpaqueRef(callbacks.claimant_ref, 'claimant_ref');
  const prepared = await prepareOperation(state, request, callbacks.verifyUnderReservation);
  if (prepared.alreadyCommitted) return prepared.operation;
  const started = await startEffect(state, {
    operation_ref: prepared.operation.operation_ref,
    expected_version: prepared.operation.version,
    claimant_ref: claimantRef,
  });

  let result;
  try {
    // This direct call is intentionally made immediately after the durable
    // effect_started transaction returns. There is no retry path from this
    // state; effect_key is supplied only for downstream idempotency/fencing.
    result = callbacks.performEffect(deepFreeze({
      operation_ref: started.operation.operation_ref,
      request_hash: started.operation.request_hash,
      authority_request_hash: started.operation.authority_request_hash,
      effect_key: started.effect_key,
      idempotency_key: started.effect_key,
      effect_started_at: started.operation.effect_started_at,
      authority_flags: {
        effect_key_grants_authority: false,
        automatic_retry_allowed: false,
      },
    }));
    result = await Promise.resolve(result);
  } catch {
    const failureCode = 'EFFECT_CALLBACK_FAILED';
    await markAmbiguous(state, {
      operation_ref: started.operation.operation_ref,
      expected_version: started.operation.version,
      effect_token: started.effect_token,
      failure_code: failureCode,
      failure_message: 'effect_callback_failed_after_durable_claim',
    }).catch(() => {});
    throw new DistributedAuthorityAmbiguousError(
      'Distributed effect began and did not finalize; automatic retry is forbidden',
      {
        operation_ref: started.operation.operation_ref,
        effect_key: started.effect_key,
        cause_code: failureCode,
      },
    );
  }

  try {
    const finalized = await finalizeEffect(state, {
      operation_ref: started.operation.operation_ref,
      expected_version: started.operation.version,
      effect_token: started.effect_token,
      result: cloneJson(result ?? null),
    });
    return finalized.operation;
  } catch {
    const observed = await getOperation(state, started.operation.operation_ref).catch(() => null);
    if (observed?.status === 'committed'
      && safeEqual(observed.result_hash, sha256Ref(result ?? null))) {
      return observed;
    }
    const failureCode = 'DURABLE_FINALIZATION_FAILED';
    await markAmbiguous(state, {
      operation_ref: started.operation.operation_ref,
      expected_version: started.operation.version,
      effect_token: started.effect_token,
      failure_code: failureCode,
      failure_message: 'effect_returned_but_durable_finalization_failed',
    }).catch(() => {});
    throw new DistributedAuthorityAmbiguousError(
      'Distributed effect returned but durable finalization is unresolved',
      {
        operation_ref: started.operation.operation_ref,
        effect_key: started.effect_key,
        cause_code: failureCode,
      },
    );
  }
}

function createInternals(options) {
  const schemaName = requireString(
    options.schemaName ?? 'risk_fork_authority',
    'PostgreSQL schema name',
    { maxLength: 63 },
  );
  return {
    connectionString: requireString(options.connectionString, 'PostgreSQL connection string', {
      maxLength: 8192,
    }),
    authorityId: requireOpaqueRef(options.authorityId ?? 'risk-fork-authority:default', 'authorityId'),
    schemaName,
    quotedSchema: quoteIdentifier(schemaName),
    maxConnections: options.maxConnections ?? 16,
    connectionTimeoutMs: options.connectionTimeoutMs ?? 5_000,
    statementTimeoutMs: options.statementTimeoutMs ?? 30_000,
    maxTransactionAttempts: options.maxTransactionAttempts ?? 4,
    verifyAuthorizationIntegrity: options.verifyAuthorizationIntegrity ?? null,
    verifyReconciliation: options.verifyReconciliation ?? null,
    initializing: null,
    pool: null,
  };
}

async function initializeAuthority(state) {
  let postgres;
  try {
    postgres = await import('pg');
  } catch (error) {
    const unavailable = new Error('The PostgreSQL authority requires the reviewed pg package');
    unavailable.code = 'POSTGRES_AUTHORITY_DRIVER_UNAVAILABLE';
    unavailable.cause = error;
    throw unavailable;
  }
  const Pool = postgres.Pool ?? postgres.default?.Pool;
  if (typeof Pool !== 'function') throw new Error('The pg package does not export Pool');
  const pool = new Pool({
    connectionString: state.connectionString,
    max: state.maxConnections,
    connectionTimeoutMillis: state.connectionTimeoutMs,
    query_timeout: state.statementTimeoutMs,
    application_name: 'agoragentic-risk-fork-authority',
  });
  try {
    const migrationTemplate = await readFile(MIGRATION_URL, 'utf8');
    const migrationSource = migrationTemplate.replace(/\r\n?/g, '\n');
    const migrationHash = sha256Ref(migrationSource);
    const migrationSql = migrationSource.replaceAll('__RISK_FORK_SCHEMA__', state.quotedSchema);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(1380338246, 303)');
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${state.quotedSchema}`);
      await client.query(
        `CREATE TABLE IF NOT EXISTS ${table(state, 'authority_schema_migrations')} (
           version integer PRIMARY KEY CHECK (version >= 1),
           migration_hash text NOT NULL CHECK (migration_hash ~ '^sha256:[a-f0-9]{64}$'),
           applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
         )`,
      );
      const applied = await client.query(
        `SELECT migration_hash
           FROM ${table(state, 'authority_schema_migrations')}
          WHERE version = 1 FOR UPDATE`,
      );
      if (applied.rowCount === 0) {
        await client.query(migrationSql);
        await client.query(
          `INSERT INTO ${table(state, 'authority_schema_migrations')} (
             version, migration_hash, applied_at
           ) VALUES (1, $1, clock_timestamp())`,
          [migrationHash],
        );
      } else if (!safeEqual(applied.rows[0].migration_hash, migrationHash)) {
        throw distributedAuthorityError(
          'Applied PostgreSQL authority migration differs from the reviewed source',
          'DISTRIBUTED_AUTHORITY_MIGRATION_HASH_MISMATCH',
          { schema_name: state.schemaName, version: 1 },
        );
      }
      await client.query(
        `INSERT INTO ${table(state, 'authority_meta')} (authority_id)
         VALUES ($1) ON CONFLICT (authority_id) DO NOTHING`,
        [state.authorityId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    state.pool = pool;
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

export class PostgresDistributedCommitAuthority {
  constructor(options = {}) {
    if (new.target !== PostgresDistributedCommitAuthority) {
      throw new TypeError('PostgresDistributedCommitAuthority cannot be subclassed');
    }
    assertPlainObject(options, 'PostgreSQL distributed authority options');
    assertAllowedKeys(options, [
      'connectionString',
      'authorityId',
      'schemaName',
      'maxConnections',
      'connectionTimeoutMs',
      'statementTimeoutMs',
      'maxTransactionAttempts',
      'verifyAuthorizationIntegrity',
      'verifyReconciliation',
    ], 'PostgreSQL distributed authority options');
    for (const [field, value, min, max] of [
      ['maxConnections', options.maxConnections ?? 16, 1, 100],
      ['connectionTimeoutMs', options.connectionTimeoutMs ?? 5_000, 100, 120_000],
      ['statementTimeoutMs', options.statementTimeoutMs ?? 30_000, 100, 300_000],
      ['maxTransactionAttempts', options.maxTransactionAttempts ?? 4, 1, 10],
    ]) {
      if (!Number.isSafeInteger(value) || value < min || value > max) {
        throw new TypeError(`${field} must be an integer between ${min} and ${max}`);
      }
    }
    if (options.verifyAuthorizationIntegrity !== undefined
      && typeof options.verifyAuthorizationIntegrity !== 'function') {
      throw new TypeError('verifyAuthorizationIntegrity must be a function');
    }
    if (options.verifyReconciliation !== undefined
      && typeof options.verifyReconciliation !== 'function') {
      throw new TypeError('verifyReconciliation must be a function');
    }
    POSTGRES_AUTHORITIES.set(this, createInternals(options));
    Object.freeze(this);
  }

  async initialize() {
    const state = POSTGRES_AUTHORITIES.get(this);
    if (!state) throw new TypeError('An exact concrete PostgresDistributedCommitAuthority is required');
    if (state.pool) return this;
    if (!state.initializing) state.initializing = initializeAuthority(state);
    const initializing = state.initializing;
    try {
      await initializing;
    } finally {
      if (state.initializing === initializing) state.initializing = null;
    }
    return this;
  }

  async close() {
    const state = POSTGRES_AUTHORITIES.get(this);
    if (!state) throw new TypeError('An exact concrete PostgresDistributedCommitAuthority is required');
    if (state.initializing) await state.initializing.catch(() => {});
    const pool = state?.pool;
    if (pool) {
      state.pool = null;
      await pool.end();
    }
  }

  seedParentHead(input) {
    return seedParent(assertAuthority(this), input);
  }

  setCurrentGovernance(input) {
    return setGovernance(assertAuthority(this), input);
  }

  registerCommitApproval(input) {
    return registerApproval(assertAuthority(this), input);
  }

  revokeCommitApproval(input) {
    return revokeApproval(assertAuthority(this), input);
  }

  registerExecutionAuthorization(input) {
    return registerAuthorization(assertAuthority(this), input);
  }

  revokeExecutionAuthorization(input) {
    return revokeAuthorization(assertAuthority(this), input);
  }

  runCommit(input, callbacks) {
    return runCommit(assertAuthority(this), input, callbacks);
  }

  recoverPreparedOperation(input) {
    return recoverPrepared(assertAuthority(this), input);
  }

  reconcileOperation(input) {
    return reconcile(assertAuthority(this), input);
  }

  getOperation(operationRef) {
    return getOperation(assertAuthority(this), operationRef);
  }

  listUnresolved(input) {
    return listUnresolved(assertAuthority(this), input);
  }

  getAuditTrail(input) {
    return getAuditTrail(assertAuthority(this), input);
  }
}

Object.freeze(PostgresDistributedCommitAuthority.prototype);
Object.freeze(PostgresDistributedCommitAuthority);

export function isPostgresDistributedCommitAuthority(value) {
  return POSTGRES_AUTHORITIES.has(value);
}
