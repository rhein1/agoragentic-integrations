import { assertCanonicalJson, canonicalize, sha256Ref } from './canonical.mjs';
import { EVIDENCE_STATUSES, FORK_RESOURCE_STATES, RUN_STATES } from './constants.mjs';
import {
  assertAllowedKeys,
  assertPlainObject,
  boundedInteger,
  cloneJson,
  deepFreeze,
  requireEnum,
  requireIsoDate,
  requireOpaqueRef,
  requireSha256Ref,
  requireString,
  safeEqual,
} from './util.mjs';

const CLEAN_ACTOR = 'clean_controller';

const TRANSITIONS = Object.freeze({
  REQUESTED: ['SAVEPOINTING', 'ABORTING'],
  SAVEPOINTING: ['SAVEPOINT_READY', 'SAVEPOINT_FAILED', 'ABORTING'],
  SAVEPOINT_READY: ['FORK_STARTING', 'ABORTING'],
  SAVEPOINT_FAILED: ['DESTROYING'],
  FORK_STARTING: ['FORK_READY', 'FORK_FAILED', 'ABORTING'],
  FORK_READY: ['EXECUTING', 'ABORTING'],
  FORK_FAILED: ['DESTROYING'],
  EXECUTING: ['TAINTED', 'EXECUTION_FAILED', 'ABORTING'],
  TAINTED: ['VALIDATING', 'ABORTING'],
  EXECUTION_FAILED: ['DESTROYING'],
  VALIDATING: ['COMMIT_READY', 'VALIDATION_FAILED', 'ABORTING'],
  COMMIT_READY: ['PRECOMMIT_DESTROYING', 'ABORTING'],
  VALIDATION_FAILED: ['DESTROYING'],
  PRECOMMIT_DESTROYING: [
    'CLEAN_COMMIT_READY',
    'DESTROYED',
    'DESTRUCTION_UNKNOWN',
    'DESTRUCTION_FAILED',
  ],
  CLEAN_COMMIT_READY: ['COMMITTING', 'ABORTING'],
  COMMITTING: ['COMMITTED', 'COMMIT_FAILED', 'COMMIT_AMBIGUOUS'],
  COMMITTED: [],
  COMMIT_FAILED: [],
  COMMIT_AMBIGUOUS: [],
  ABORTING: ['ABORTED'],
  ABORTED: ['DESTROYING'],
  DESTROYING: ['DESTROYED', 'DESTRUCTION_UNKNOWN', 'DESTRUCTION_FAILED'],
  DESTRUCTION_UNKNOWN: ['DESTROYING'],
  DESTRUCTION_FAILED: ['DESTROYING'],
  DESTROYED: [],
});

const RESOURCE_TRANSITIONS = Object.freeze({
  NOT_CREATED: ['NOT_CREATED', 'ACTIVE', 'DESTROY_REQUESTED'],
  ACTIVE: ['ACTIVE', 'SUSPENDED', 'DESTROY_REQUESTED'],
  SUSPENDED: ['SUSPENDED', 'DESTROY_REQUESTED'],
  DESTROY_REQUESTED: ['DESTROY_REQUESTED', 'DESTROYED', 'DESTROY_UNKNOWN'],
  DESTROY_UNKNOWN: ['DESTROY_UNKNOWN', 'DESTROY_REQUESTED', 'DESTROYED'],
  DESTROYED: ['DESTROYED'],
});

function assertCleanActor(value) {
  if (value !== CLEAN_ACTOR) {
    throw new Error('Only the clean controller may append Risk Fork lifecycle events');
  }
  return value;
}

function normalizeEvidence(value = {}) {
  assertAllowedKeys(value, ['status', 'ref', 'hash', 'detail'], 'transition evidence');
  return {
    status: requireEnum(value.status ?? 'observed', EVIDENCE_STATUSES, 'evidence.status'),
    ref: value.ref == null ? null : requireOpaqueRef(value.ref, 'evidence.ref'),
    hash: value.hash == null ? null : requireSha256Ref(value.hash, 'evidence.hash'),
    detail: value.detail == null
      ? null
      : requireOpaqueRef(value.detail, 'evidence.detail', { maxLength: 500 }),
  };
}

function assertDestructionSemantics(to, previousResourceState, resourceState, evidence) {
  const resourceBecameDestroyed = previousResourceState !== 'DESTROYED'
    && resourceState === 'DESTROYED';
  if (resourceBecameDestroyed) {
    if (!['CLEAN_COMMIT_READY', 'DESTROYED'].includes(to) || evidence.status !== 'verified') {
      throw new Error('Fork resource destruction requires a verified clean-boundary event');
    }
  }
  if (to === 'CLEAN_COMMIT_READY') {
    if (resourceState !== 'DESTROYED'
      || evidence.status !== 'verified'
      || !evidence.ref
      || !evidence.hash) {
      throw new Error(
        'CLEAN_COMMIT_READY requires verified fork destruction evidence with ref and hash',
      );
    }
  }
  if (to === 'DESTROYED') {
    if (resourceState !== 'DESTROYED'
      || evidence.status !== 'verified'
      || !evidence.ref
      || !evidence.hash) {
      throw new Error('DESTROYED requires verified fork destruction evidence');
    }
  }
  if (to === 'DESTRUCTION_UNKNOWN' && evidence.status !== 'unknown') {
    throw new Error('DESTRUCTION_UNKNOWN requires unknown evidence status');
  }
  if (to === 'DESTRUCTION_FAILED' && evidence.status !== 'failed') {
    throw new Error('DESTRUCTION_FAILED requires failed evidence status');
  }
}

function assertResourceLifecycleCoupling(runState, previousResourceState, resourceState) {
  if (previousResourceState === 'NOT_CREATED' && resourceState === 'ACTIVE'
    && !['FORK_STARTING', 'FORK_READY'].includes(runState)) {
    throw new Error('Fork resource lifecycle cannot become ACTIVE before FORK_READY');
  }
  if (['ACTIVE', 'SUSPENDED'].includes(resourceState)
    && ['REQUESTED', 'SAVEPOINTING', 'SAVEPOINT_READY'].includes(runState)) {
    throw new Error(`Fork resource state ${resourceState} is incompatible with ${runState}`);
  }
}

function buildEvent({
  sequence,
  at,
  from,
  to,
  reason,
  evidence,
  previousHash,
  previousResourceState,
  resourceState,
}) {
  assertResourceLifecycleCoupling(to, previousResourceState, resourceState);
  assertDestructionSemantics(to, previousResourceState, resourceState, evidence);
  const event = {
    sequence,
    at,
    actor: CLEAN_ACTOR,
    from,
    to,
    reason,
    evidence,
    fork_resource_state: resourceState,
    previous_event_hash: previousHash,
    event_hash: null,
  };
  event.event_hash = sha256Ref({ ...event, event_hash: null });
  return event;
}

function assertExpectedHead(lifecycle, input) {
  assertCleanActor(input.actor);
  const expectedVersion = boundedInteger(input.expected_version, 'expected_version', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  if (expectedVersion !== lifecycle.version) {
    throw new Error(`Lifecycle version conflict: expected ${expectedVersion}, current ${lifecycle.version}`);
  }
  const expectedHead = requireSha256Ref(input.expected_chain_head, 'expected_chain_head');
  if (!safeEqual(expectedHead, lifecycle.chain_head)) {
    throw new Error('Lifecycle chain-head conflict');
  }
}

export function createLifecycle(input = {}) {
  assertAllowedKeys(input, ['run_id', 'requested_at', 'reason', 'evidence', 'actor'], 'lifecycle input');
  assertCleanActor(input.actor);
  const runId = requireOpaqueRef(input.run_id, 'run_id', { maxLength: 200 });
  const requestedAt = requireIsoDate(input.requested_at ?? new Date(), 'requested_at');
  const reason = requireString(input.reason ?? 'risk_fork_requested', 'reason', { maxLength: 500 });
  const event = buildEvent({
    sequence: 0,
    at: requestedAt,
    from: null,
    to: 'REQUESTED',
    reason,
    evidence: normalizeEvidence(input.evidence),
    previousHash: null,
    previousResourceState: 'NOT_CREATED',
    resourceState: 'NOT_CREATED',
  });
  return deepFreeze({
    schema: 'agoragentic.risk-fork.lifecycle.v1',
    run_id: runId,
    version: 0,
    state: 'REQUESTED',
    fork_resource_state: 'NOT_CREATED',
    events: [event],
    chain_head: event.event_hash,
  });
}

export function transitionLifecycle(lifecycle, input = {}) {
  verifyLifecycle(lifecycle);
  assertAllowedKeys(input, [
    'actor',
    'expected_version',
    'expected_chain_head',
    'to',
    'at',
    'reason',
    'evidence',
    'fork_resource_state',
  ], 'transition input');
  assertExpectedHead(lifecycle, input);
  const from = lifecycle.state;
  const to = requireEnum(input.to, RUN_STATES, 'to');
  if (!TRANSITIONS[from].includes(to)) {
    throw new Error(`Invalid Risk Fork transition: ${from} -> ${to}`);
  }
  const at = requireIsoDate(input.at ?? new Date(), 'at');
  const last = lifecycle.events.at(-1);
  if (Date.parse(at) < Date.parse(last.at)) throw new Error('Lifecycle event time cannot move backward');
  const resourceState = input.fork_resource_state === undefined
    ? lifecycle.fork_resource_state
    : requireEnum(input.fork_resource_state, FORK_RESOURCE_STATES, 'fork_resource_state');
  if (!RESOURCE_TRANSITIONS[lifecycle.fork_resource_state].includes(resourceState)) {
    throw new Error(
      `Invalid fork resource transition: ${lifecycle.fork_resource_state} -> ${resourceState}`,
    );
  }
  const event = buildEvent({
    sequence: lifecycle.events.length,
    at,
    from,
    to,
    reason: requireString(input.reason, 'reason', { maxLength: 500 }),
    evidence: normalizeEvidence(input.evidence),
    previousHash: lifecycle.chain_head,
    previousResourceState: lifecycle.fork_resource_state,
    resourceState,
  });
  return deepFreeze({
    ...cloneJson(lifecycle),
    version: lifecycle.version + 1,
    state: to,
    fork_resource_state: resourceState,
    events: [...cloneJson(lifecycle.events), event],
    chain_head: event.event_hash,
  });
}

export function recordResourceState(lifecycle, input = {}) {
  verifyLifecycle(lifecycle);
  assertAllowedKeys(input, [
    'actor',
    'expected_version',
    'expected_chain_head',
    'state',
    'at',
    'reason',
    'evidence',
  ], 'resource transition input');
  assertExpectedHead(lifecycle, input);
  const resourceState = requireEnum(input.state, FORK_RESOURCE_STATES, 'resource state');
  if (!RESOURCE_TRANSITIONS[lifecycle.fork_resource_state].includes(resourceState)) {
    throw new Error(
      `Invalid fork resource transition: ${lifecycle.fork_resource_state} -> ${resourceState}`,
    );
  }
  const at = requireIsoDate(input.at ?? new Date(), 'at');
  const last = lifecycle.events.at(-1);
  if (Date.parse(at) < Date.parse(last.at)) throw new Error('Lifecycle event time cannot move backward');
  const event = buildEvent({
    sequence: lifecycle.events.length,
    at,
    from: lifecycle.state,
    to: lifecycle.state,
    reason: requireString(input.reason, 'reason', { maxLength: 500 }),
    evidence: normalizeEvidence(input.evidence),
    previousHash: lifecycle.chain_head,
    previousResourceState: lifecycle.fork_resource_state,
    resourceState,
  });
  return deepFreeze({
    ...cloneJson(lifecycle),
    version: lifecycle.version + 1,
    fork_resource_state: resourceState,
    events: [...cloneJson(lifecycle.events), event],
    chain_head: event.event_hash,
  });
}

export function verifyLifecycle(lifecycle) {
  assertCanonicalJson(lifecycle);
  assertPlainObject(lifecycle, 'lifecycle');
  assertAllowedKeys(lifecycle, [
    'schema',
    'run_id',
    'version',
    'state',
    'fork_resource_state',
    'events',
    'chain_head',
  ], 'lifecycle');
  if (lifecycle.schema !== 'agoragentic.risk-fork.lifecycle.v1') {
    throw new TypeError('lifecycle must use agoragentic.risk-fork.lifecycle.v1');
  }
  requireOpaqueRef(lifecycle.run_id, 'lifecycle.run_id');
  requireEnum(lifecycle.state, RUN_STATES, 'lifecycle.state');
  requireEnum(lifecycle.fork_resource_state, FORK_RESOURCE_STATES, 'lifecycle.fork_resource_state');
  if (!Array.isArray(lifecycle.events) || lifecycle.events.length === 0) {
    throw new TypeError('lifecycle.events must be a non-empty array');
  }
  boundedInteger(lifecycle.version, 'lifecycle.version', { min: 0, max: Number.MAX_SAFE_INTEGER });
  if (lifecycle.version !== lifecycle.events.length - 1) {
    throw new Error('Lifecycle version does not match its event count');
  }
  let previousHash = null;
  let state = null;
  let resourceState = 'NOT_CREATED';
  let lastAt = null;
  for (const [index, event] of lifecycle.events.entries()) {
    assertPlainObject(event, `lifecycle.events[${index}]`);
    assertAllowedKeys(event, [
      'sequence',
      'at',
      'actor',
      'from',
      'to',
      'reason',
      'evidence',
      'fork_resource_state',
      'previous_event_hash',
      'event_hash',
    ], `lifecycle.events[${index}]`);
    if (event.sequence !== index) throw new Error(`Lifecycle sequence mismatch at event ${index}`);
    assertCleanActor(event.actor);
    const at = requireIsoDate(event.at, `lifecycle.events[${index}].at`);
    if (lastAt && Date.parse(at) < Date.parse(lastAt)) {
      throw new Error(`Lifecycle time moves backward at event ${index}`);
    }
    lastAt = at;
    if (event.previous_event_hash !== previousHash) {
      throw new Error(`Lifecycle predecessor mismatch at event ${index}`);
    }
    if (event.from !== state) throw new Error(`Lifecycle from-state mismatch at event ${index}`);
    requireEnum(event.to, RUN_STATES, `lifecycle.events[${index}].to`);
    const reason = requireString(
      event.reason,
      `lifecycle.events[${index}].reason`,
      { maxLength: 500 },
    );
    if (reason !== event.reason) throw new Error(`Lifecycle reason is not canonical at event ${index}`);
    requireEnum(
      event.fork_resource_state,
      FORK_RESOURCE_STATES,
      `lifecycle.events[${index}].fork_resource_state`,
    );
    const evidence = normalizeEvidence(event.evidence);
    if (canonicalize(evidence) !== canonicalize(event.evidence)) {
      throw new Error(`Lifecycle evidence is not canonical at event ${index}`);
    }
    if (index === 0) {
      if (event.to !== 'REQUESTED' || event.from !== null || event.fork_resource_state !== 'NOT_CREATED') {
        throw new Error('Lifecycle genesis event is invalid');
      }
    } else {
      if (event.to !== event.from && !TRANSITIONS[event.from].includes(event.to)) {
        throw new Error(`Invalid recorded transition at event ${index}`);
      }
      if (!RESOURCE_TRANSITIONS[resourceState].includes(event.fork_resource_state)) {
        throw new Error(`Invalid recorded resource transition at event ${index}`);
      }
    }
    assertResourceLifecycleCoupling(event.to, resourceState, event.fork_resource_state);
    assertDestructionSemantics(event.to, resourceState, event.fork_resource_state, evidence);
    const expectedHash = sha256Ref({ ...event, event_hash: null });
    if (!safeEqual(event.event_hash, expectedHash)) {
      throw new Error(`Lifecycle event hash mismatch at event ${index}`);
    }
    previousHash = event.event_hash;
    state = event.to;
    resourceState = event.fork_resource_state;
  }
  if (lifecycle.state !== state || lifecycle.fork_resource_state !== resourceState) {
    throw new Error('Lifecycle head state does not match its event chain');
  }
  if (!safeEqual(lifecycle.chain_head, previousHash)) throw new Error('Lifecycle chain_head mismatch');
  return true;
}

export function allowedTransitions(state) {
  requireEnum(state, RUN_STATES, 'state');
  return [...TRANSITIONS[state]];
}
