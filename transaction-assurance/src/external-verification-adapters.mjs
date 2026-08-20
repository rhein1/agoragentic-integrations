import { createHash } from 'node:crypto';

import {
  computeEnvelopeHash,
  sha256Ref,
} from './index.mjs';
import {
  bindTrustedEnvelope,
  trustedEnvelopeBinding,
} from './trusted-verifier-boundary.mjs';

const ACTION_REF_PROFILE = 'mycelium-action-ref-v1.0';
const ANCHOR_PROFILE = 'mycelium-anchor-registry-v1';
const REGISTRY_ADDRESS = '0x49feca52bc634a9ab773226d16619dec547794aa';
const RUNTIME_CODE_SHA256 = 'sha256:e2f5675b490dbb4211cfbeb89a8e8913a2215843c91c33ced8f46935b83d82ed';
const ANCHOR_SELECTOR = '0xeecdf927';
const ANCHORED_EVENT_TOPIC = '0xfe2289542f7a0110ac112c3a4d712afdcaaf2900a1326f4e6f340b563a0e8734';
const MINIMUM_CONFIRMATIONS = 12;
const ALLOWED_CHAINS = Object.freeze([
  'eip155:8453',
  'eip155:42161',
  'eip155:57073',
]);
const ALLOWED_CHAIN_SET = new Set(ALLOWED_CHAINS);
const trustedActionReferenceBindings = new WeakMap();
const trustedExternalVerificationBindings = new WeakMap();
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HEX_32_PATTERN = /^0x[a-f0-9]{64}$/;
const BARE_HEX_32_PATTERN = /^[a-f0-9]{64}$/;
const ADDRESS_PATTERN = /^0x[a-f0-9]{40}$/;
const SHA256_REF_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DECIMAL_UINT_PATTERN = /^(0|[1-9]\d*)$/;

export const MYCELIUM_EXTERNAL_VERIFICATION_PINS = Object.freeze({
  action_ref_v1: Object.freeze({
    profile: ACTION_REF_PROFILE,
    derivation_version: 'v1',
    specification_tag: 'action-ref-v2.0',
    revision: '2935c328177dca9f042fa1b910f5237ffe71da9e',
    source: 'https://github.com/giskard09/argentum-core/tree/2935c328177dca9f042fa1b910f5237ffe71da9e',
    specification_sha256: 'sha256:c893d29e8d992e88442eccdde502e22edda0c20a580d391c56af988642452554',
    vector_set_sha256: 'sha256:b6604d03c3f119224b594135d651eb74b205770cc276c46acd95dd800feb9050',
    negative_vector_set_sha256: 'sha256:eae765de97298e2d086c41867922b7a6fe14eee4fd7efa572257658ce6876de9',
    canonicalization: 'jcs-rfc8785-v1-ascii-string-domain',
    timestamp_representation: 'rfc3339-utc-millisecond-3-digit-z',
    domain_separation: 'none',
    hash_algorithm: 'sha256',
  }),
  anchor_registry_v1: Object.freeze({
    profile: ANCHOR_PROFILE,
    revision: 'cd8100e63d17882ba11843882acaf5b1e069fdce',
    source: 'https://github.com/giskard09/giskard-payments/tree/cd8100e63d17882ba11843882acaf5b1e069fdce',
    source_sha256: 'sha256:82437f6f5ba3952a2c7ac34700e82c03bc819662687a2d23f7cfce72aee903a0',
    registry_address: REGISTRY_ADDRESS,
    runtime_code_sha256: RUNTIME_CODE_SHA256,
    anchor_selector: ANCHOR_SELECTOR,
    anchored_event_topic: ANCHORED_EVENT_TOPIC,
    allowed_chain_ids: ALLOWED_CHAINS,
    minimum_confirmations: MINIMUM_CONFIRMATIONS,
  }),
});

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactObject(value, field, required, optional = []) {
  if (!isObject(value)) throw new TypeError(`${field} must be an object`);
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new TypeError(
      `${field} must use the exact field set; missing=${missing.join(',') || 'none'} unknown=${unknown.join(',') || 'none'}`,
    );
  }
  return value;
}

function requiredText(value, field, maxLength = 2048) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${field} is required`);
  return value.trim().slice(0, maxLength);
}

function optionalText(value, field, maxLength = 2048) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, field, maxLength);
}

function exactLowerHex(value, pattern, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!pattern.test(normalized) || value !== normalized) {
    throw new TypeError(`${field} must use canonical lowercase hexadecimal encoding`);
  }
  return normalized;
}

function address(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!ADDRESS_PATTERN.test(normalized)) throw new TypeError(`${field} must be an EVM address`);
  return normalized;
}

function sha256Reference(value, field) {
  const normalized = requiredText(value, field).toLowerCase();
  if (!SHA256_REF_PATTERN.test(normalized)) throw new TypeError(`${field} must be a sha256 reference`);
  return normalized;
}

function uintString(value, field) {
  const normalized = typeof value === 'bigint' ? value.toString() : String(value);
  if (!DECIMAL_UINT_PATTERN.test(normalized)) throw new TypeError(`${field} must be an unsigned decimal integer`);
  return normalized;
}

function safeIndex(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative safe integer`);
  return value;
}

function checkedAt(value, field) {
  const date = new Date(requiredText(value, field));
  if (Number.isNaN(date.getTime())) throw new TypeError(`${field} must be a date-time`);
  return date.toISOString();
}

function noAuthority() {
  return {
    evidence_grants_authority: false,
    can_spend: false,
    can_execute: false,
    can_fund_wallet: false,
    can_publish: false,
    can_deploy: false,
    can_change_trust: false,
  };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function sha256Bytes(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function normalizedActionReference(reference) {
  if (reference?.schema === 'agoragentic.external-action-reference.v1') {
    if (reference.source_revision !== MYCELIUM_EXTERNAL_VERIFICATION_PINS.action_ref_v1.revision) {
      throw new TypeError('external action-reference source revision mismatch');
    }
    return normalizeExternalActionReference({
      profile: reference.profile,
      value: reference.value,
      ...(reference.preimage_ref ? { preimage_ref: reference.preimage_ref } : {}),
    }, {
      artifactRef: reference.source_artifact_ref ?? undefined,
    });
  }
  return normalizeExternalActionReference(reference);
}

function actionReferenceForBinding(reference) {
  const normalized = normalizedActionReference(reference);
  if (reference?.schema !== 'agoragentic.external-action-reference.v1') return normalized;
  if (!['not_checked', 'match', 'mismatch'].includes(reference.recomputation)) {
    throw new TypeError('external action-reference recomputation status is unsupported');
  }
  return {
    ...normalized,
    recomputation: reference.recomputation,
    ...(isObject(reference.checks) ? { checks: structuredClone(reference.checks) } : {}),
  };
}

export function normalizeExternalActionReference(artifact, options = {}) {
  exactObject(artifact, 'artifact', ['profile', 'value'], ['preimage_ref']);
  if (artifact.profile !== ACTION_REF_PROFILE) {
    throw new TypeError(`unsupported external action-reference profile: ${artifact.profile}`);
  }
  const value = exactLowerHex(artifact.value, BARE_HEX_32_PATTERN, 'artifact.value');
  const preimageRef = artifact.preimage_ref === undefined
    ? null
    : sha256Reference(artifact.preimage_ref, 'artifact.preimage_ref');
  return {
    schema: 'agoragentic.external-action-reference.v1',
    profile: ACTION_REF_PROFILE,
    source_revision: MYCELIUM_EXTERNAL_VERIFICATION_PINS.action_ref_v1.revision,
    source_artifact_ref: optionalText(options.artifactRef, 'options.artifactRef'),
    source_artifact_hash: sha256Ref(artifact),
    source_artifact_embedded: false,
    value,
    preimage_ref: preimageRef,
    recomputation: 'not_checked',
    canonicalization: MYCELIUM_EXTERNAL_VERIFICATION_PINS.action_ref_v1.canonicalization,
    timestamp_representation: MYCELIUM_EXTERNAL_VERIFICATION_PINS.action_ref_v1.timestamp_representation,
    domain_separation: 'none',
    hash_algorithm: 'sha256',
    limitations: ['no_protocol_domain_separation'],
    authority_flags: noAuthority(),
  };
}

function canonicalActionPreimage(preimage) {
  exactObject(preimage, 'preimage', ['agent_id', 'action_type', 'scope', 'timestamp']);
  for (const field of ['agent_id', 'action_type', 'scope', 'timestamp']) {
    if (typeof preimage[field] !== 'string') throw new TypeError(`preimage.${field} must be a string`);
  }
  for (const field of ['agent_id', 'action_type', 'scope']) {
    if (!/^[\x00-\x7f]*$/.test(preimage[field])) {
      throw new TypeError(`OUT_OF_PROFILE_DOMAIN: ${field}: non-ASCII character in field value`);
    }
  }
  if (!TIMESTAMP_PATTERN.test(preimage.timestamp)) {
    throw new TypeError(
      'OUT_OF_PROFILE_DOMAIN: timestamp: expected YYYY-MM-DDTHH:MM:SS.mmmZ',
    );
  }
  return JSON.stringify({
    action_type: preimage.action_type,
    agent_id: preimage.agent_id,
    scope: preimage.scope,
    timestamp: preimage.timestamp,
  });
}

export function verifyExternalActionReferencePreimage(reference, preimage, options = {}) {
  const normalized = normalizedActionReference(reference);
  if (options.profile !== undefined && options.profile !== ACTION_REF_PROFILE) {
    throw new TypeError(`unsupported external action-reference profile: ${options.profile}`);
  }
  const canonical = canonicalActionPreimage(preimage);
  const digest = createHash('sha256').update(canonical, 'utf8').digest('hex');
  const preimageRef = `sha256:${digest}`;
  if (normalized.preimage_ref && normalized.preimage_ref !== preimageRef) {
    return {
      ...normalized,
      preimage_ref: preimageRef,
      recomputation: 'mismatch',
      checks: {
        exact_profile: true,
        canonical_domain: true,
        preimage_ref: false,
        value: false,
      },
    };
  }
  const match = normalized.value === digest;
  const result = {
    ...normalized,
    preimage_ref: preimageRef,
    recomputation: match ? 'match' : 'mismatch',
    checks: {
      exact_profile: true,
      canonical_domain: true,
      preimage_ref: true,
      value: match,
    },
  };
  if (match) {
    trustedActionReferenceBindings.set(result, Object.freeze({
      result_hash: sha256Ref(result),
    }));
  }
  return result;
}

function normalizedAnchorEvidence(evidence) {
  if (evidence?.schema === 'agoragentic.external-anchor-evidence.v1') {
    if (evidence.source_revision !== MYCELIUM_EXTERNAL_VERIFICATION_PINS.anchor_registry_v1.revision) {
      throw new TypeError('external anchor source revision mismatch');
    }
    return normalizeAnchorEvidence({
      profile: evidence.profile,
      action_reference_profile: evidence.action_reference_profile,
      action_reference: evidence.action_reference,
      chain_id: evidence.chain_id,
      registry_address: evidence.registry_address,
      transaction_hash: evidence.transaction_hash,
      block_number: evidence.block_number,
      log_index: evidence.log_index,
    }, {
      artifactRef: evidence.source_artifact_ref ?? undefined,
    });
  }
  return normalizeAnchorEvidence(evidence);
}

export function normalizeAnchorEvidence(evidence, options = {}) {
  exactObject(evidence, 'evidence', [
    'profile',
    'action_reference_profile',
    'action_reference',
    'chain_id',
    'registry_address',
    'transaction_hash',
    'block_number',
    'log_index',
  ]);
  if (evidence.profile !== ANCHOR_PROFILE) {
    throw new TypeError(`unsupported external anchor profile: ${evidence.profile}`);
  }
  if (evidence.action_reference_profile !== ACTION_REF_PROFILE) {
    throw new TypeError(`unsupported anchored action-reference profile: ${evidence.action_reference_profile}`);
  }
  const chainId = requiredText(evidence.chain_id, 'evidence.chain_id', 100);
  if (!ALLOWED_CHAIN_SET.has(chainId)) throw new TypeError(`unsupported anchor chain: ${chainId}`);
  const registryAddress = address(evidence.registry_address, 'evidence.registry_address');
  if (registryAddress !== REGISTRY_ADDRESS) throw new TypeError('anchor registry is not allowlisted');
  return {
    schema: 'agoragentic.external-anchor-evidence.v1',
    profile: ANCHOR_PROFILE,
    source_revision: MYCELIUM_EXTERNAL_VERIFICATION_PINS.anchor_registry_v1.revision,
    source_artifact_ref: optionalText(options.artifactRef, 'options.artifactRef'),
    source_artifact_hash: sha256Ref(evidence),
    source_artifact_embedded: false,
    action_reference_profile: ACTION_REF_PROFILE,
    action_reference: exactLowerHex(
      evidence.action_reference,
      BARE_HEX_32_PATTERN,
      'evidence.action_reference',
    ),
    chain_id: chainId,
    registry_address: registryAddress,
    transaction_hash: exactLowerHex(evidence.transaction_hash, HEX_32_PATTERN, 'evidence.transaction_hash'),
    block_number: uintString(evidence.block_number, 'evidence.block_number'),
    log_index: safeIndex(evidence.log_index, 'evidence.log_index'),
    status: 'not_checked',
    raw_rpc_payload_embedded: false,
    authority_flags: noAuthority(),
  };
}

function normalizeVerifierEvent(event, index) {
  const field = `verifier.result.events[${index}]`;
  exactObject(event, field, [
    'transaction_hash',
    'address',
    'block_number',
    'block_hash',
    'log_index',
    'removed',
    'topics',
    'data',
  ]);
  if (!Array.isArray(event.topics) || event.topics.length !== 3) {
    throw new TypeError(`${field}.topics must contain exactly three topics`);
  }
  return {
    transaction_hash: exactLowerHex(event.transaction_hash, HEX_32_PATTERN, `${field}.transaction_hash`),
    address: address(event.address, `${field}.address`),
    block_number: uintString(event.block_number, `${field}.block_number`),
    block_hash: exactLowerHex(event.block_hash, HEX_32_PATTERN, `${field}.block_hash`),
    log_index: safeIndex(event.log_index, `${field}.log_index`),
    removed: event.removed === true,
    topics: event.topics.map((topic, topicIndex) => exactLowerHex(
      topic,
      HEX_32_PATTERN,
      `${field}.topics[${topicIndex}]`,
    )),
    data: exactLowerHex(event.data, HEX_32_PATTERN, `${field}.data`),
  };
}

function verifierObservation(verifier, context) {
  if (!isObject(verifier)) throw new TypeError('options.verifier must be a trusted in-process verifier');
  const verifierId = requiredText(verifier.id, 'options.verifier.id');
  if (typeof verifier.verify !== 'function') {
    throw new TypeError('options.verifier.verify must be a trusted in-process callback');
  }
  const result = verifier.verify(deepFreeze(structuredClone(context)));
  if (result && typeof result.then === 'function') {
    throw new TypeError('options.verifier.verify must return synchronously');
  }
  exactObject(result, 'verifier.result', [
    'schema',
    'profile',
    'chain_id',
    'registry_address',
    'runtime_code',
    'transaction_hash',
    'transaction_status',
    'transaction_to',
    'transaction_input',
    'block_number',
    'block_hash',
    'block_timestamp',
    'head_block_number',
    'events',
    'verifier_ref',
    'evidence_ref',
    'checked_at',
  ]);
  if (result.schema !== 'agoragentic.external-anchor-verifier-observation.v1') {
    throw new TypeError('unsupported external anchor verifier observation schema');
  }
  if (result.profile !== ANCHOR_PROFILE) throw new TypeError('verifier profile mismatch');
  if (requiredText(result.verifier_ref, 'verifier.result.verifier_ref') !== verifierId) {
    throw new TypeError('verifier id does not match verifier_ref');
  }
  if (!Array.isArray(result.events) || result.events.length > 32) {
    throw new TypeError('verifier.result.events must be a bounded array of at most 32 events');
  }
  const transactionStatus = requiredText(result.transaction_status, 'verifier.result.transaction_status');
  if (!['success', 'reverted'].includes(transactionStatus)) {
    throw new TypeError('verifier.result.transaction_status must be success or reverted');
  }
  const runtimeCode = requiredText(result.runtime_code, 'verifier.result.runtime_code', 20_000).toLowerCase();
  if (!/^0x(?:[a-f0-9]{2})*$/.test(runtimeCode)) {
    throw new TypeError('verifier.result.runtime_code must be canonical hexadecimal bytes');
  }
  const transactionInput = requiredText(
    result.transaction_input,
    'verifier.result.transaction_input',
    20_000,
  ).toLowerCase();
  if (!/^0x(?:[a-f0-9]{2})*$/.test(transactionInput)) {
    throw new TypeError('verifier.result.transaction_input must be canonical hexadecimal bytes');
  }
  return {
    schema: result.schema,
    profile: result.profile,
    chain_id: requiredText(result.chain_id, 'verifier.result.chain_id', 100),
    registry_address: address(result.registry_address, 'verifier.result.registry_address'),
    runtime_code: runtimeCode,
    transaction_hash: exactLowerHex(result.transaction_hash, HEX_32_PATTERN, 'verifier.result.transaction_hash'),
    transaction_status: transactionStatus,
    transaction_to: address(result.transaction_to, 'verifier.result.transaction_to'),
    transaction_input: transactionInput,
    block_number: uintString(result.block_number, 'verifier.result.block_number'),
    block_hash: exactLowerHex(result.block_hash, HEX_32_PATTERN, 'verifier.result.block_hash'),
    block_timestamp: uintString(result.block_timestamp, 'verifier.result.block_timestamp'),
    head_block_number: uintString(result.head_block_number, 'verifier.result.head_block_number'),
    events: result.events.map(normalizeVerifierEvent),
    verifier_ref: verifierId,
    evidence_ref: requiredText(result.evidence_ref, 'verifier.result.evidence_ref'),
    checked_at: checkedAt(result.checked_at, 'verifier.result.checked_at'),
  };
}

function eventTimestamp(data) {
  return BigInt(data).toString();
}

export function verifyAnchorEvidence(evidence, options = {}) {
  if (options.verifierEvidence !== undefined) {
    throw new TypeError(
      'portable verifierEvidence JSON is not trusted; supply a trusted in-process verifier callback',
    );
  }
  const normalized = normalizedAnchorEvidence(evidence);
  const minimumConfirmations = options.minimumConfirmations ?? MINIMUM_CONFIRMATIONS;
  if (!Number.isSafeInteger(minimumConfirmations) || minimumConfirmations < MINIMUM_CONFIRMATIONS) {
    throw new TypeError(`minimumConfirmations must be an integer of at least ${MINIMUM_CONFIRMATIONS}`);
  }
  const context = {
    profile: ANCHOR_PROFILE,
    source_revision: MYCELIUM_EXTERNAL_VERIFICATION_PINS.anchor_registry_v1.revision,
    chain_id: normalized.chain_id,
    registry_address: normalized.registry_address,
    runtime_code_sha256: RUNTIME_CODE_SHA256,
    transaction_hash: normalized.transaction_hash,
    block_number: normalized.block_number,
    log_index: normalized.log_index,
    action_reference: normalized.action_reference,
    anchor_selector: ANCHOR_SELECTOR,
    anchored_event_topic: ANCHORED_EVENT_TOPIC,
    minimum_confirmations: minimumConfirmations,
  };
  const observed = verifierObservation(options.verifier, context);
  const expectedInput = `${ANCHOR_SELECTOR}${normalized.action_reference}`;
  const expectedReferenceTopic = `0x${normalized.action_reference}`;
  const selectedEvent = observed.events.find((event) => (
    event.transaction_hash === normalized.transaction_hash
      && event.log_index === normalized.log_index
  ));
  const confirmations = BigInt(observed.head_block_number) >= BigInt(observed.block_number)
    ? BigInt(observed.head_block_number) - BigInt(observed.block_number) + 1n
    : 0n;
  const checks = {
    chain_id: observed.chain_id === normalized.chain_id,
    registry_address: observed.registry_address === normalized.registry_address,
    runtime_code_hash: sha256Bytes(Buffer.from(observed.runtime_code.slice(2), 'hex')) === RUNTIME_CODE_SHA256,
    transaction_hash: observed.transaction_hash === normalized.transaction_hash,
    receipt_success: observed.transaction_status === 'success',
    target_contract: observed.transaction_to === normalized.registry_address,
    call_selector: observed.transaction_input.slice(0, 10) === ANCHOR_SELECTOR
      && observed.transaction_input.length === 74,
    calldata_reference: observed.transaction_input === expectedInput,
    block_number: observed.block_number === normalized.block_number,
    event_present: Boolean(selectedEvent),
    event_address: selectedEvent?.address === normalized.registry_address,
    event_topic: selectedEvent?.topics[0] === ANCHORED_EVENT_TOPIC,
    event_reference: selectedEvent?.topics[1] === expectedReferenceTopic,
    log_index: selectedEvent?.log_index === normalized.log_index,
    event_block_number: selectedEvent?.block_number === normalized.block_number,
    event_block_hash: selectedEvent?.block_hash === observed.block_hash,
    event_transaction_hash: selectedEvent?.transaction_hash === normalized.transaction_hash,
    event_not_removed: selectedEvent?.removed === false,
    event_timestamp: selectedEvent ? eventTimestamp(selectedEvent.data) === observed.block_timestamp : false,
    finality: confirmations >= BigInt(minimumConfirmations),
  };
  const failedChecks = Object.entries(checks)
    .filter(([, passed]) => passed !== true)
    .map(([name]) => name);
  const observedMatchingEventCount = observed.events.filter((event) => (
    event.address === normalized.registry_address
      && event.topics[0] === ANCHORED_EVENT_TOPIC
      && event.topics[1] === expectedReferenceTopic
      && event.removed === false
  )).length;
  const result = {
    schema: 'agoragentic.external-verification.v1',
    profile: ANCHOR_PROFILE,
    source_revision: MYCELIUM_EXTERNAL_VERIFICATION_PINS.anchor_registry_v1.revision,
    status: failedChecks.length === 0 ? 'checked_match' : 'checked_mismatch',
    action_reference_profile: ACTION_REF_PROFILE,
    action_reference: normalized.action_reference,
    checks,
    failed_checks: failedChecks,
    proves: failedChecks.length === 0
      ? ['reference_anchored', 'public_block_timestamp', 'event_inclusion']
      : [],
    does_not_prove: [
      'principal_authority',
      'execution_correctness',
      'delivery',
      'settlement',
      'single_execution',
    ],
    chain_id: normalized.chain_id,
    registry_ref: `evm:${normalized.registry_address}`,
    transaction_ref: `evm-tx:${normalized.transaction_hash}`,
    block_number: normalized.block_number,
    block_hash: observed.block_hash,
    block_timestamp: observed.block_timestamp,
    log_index: normalized.log_index,
    confirmations: confirmations.toString(),
    minimum_confirmations: minimumConfirmations,
    observed_matching_event_count: observedMatchingEventCount,
    verifier_ref: observed.verifier_ref,
    evidence_ref: observed.evidence_ref,
    checked_at: observed.checked_at,
    raw_rpc_payload_embedded: false,
    complete_chain_verified: false,
    authority_flags: noAuthority(),
  };
  trustedExternalVerificationBindings.set(result, Object.freeze({
    verifier_ref: observed.verifier_ref,
    result_hash: sha256Ref(result),
  }));
  return result;
}

function notCheckedVerification(actionReference) {
  return {
    schema: 'agoragentic.external-verification.v1',
    profile: ANCHOR_PROFILE,
    source_revision: MYCELIUM_EXTERNAL_VERIFICATION_PINS.anchor_registry_v1.revision,
    status: 'not_checked',
    action_reference_profile: ACTION_REF_PROFILE,
    action_reference: actionReference.value,
    checks: {},
    failed_checks: [],
    proves: [],
    does_not_prove: [
      'principal_authority',
      'execution_correctness',
      'delivery',
      'settlement',
      'single_execution',
    ],
    chain_id: null,
    registry_ref: null,
    transaction_ref: null,
    block_number: null,
    block_hash: null,
    block_timestamp: null,
    log_index: null,
    confirmations: null,
    minimum_confirmations: MINIMUM_CONFIRMATIONS,
    observed_matching_event_count: 0,
    verifier_ref: null,
    evidence_ref: null,
    checked_at: null,
    raw_rpc_payload_embedded: false,
    complete_chain_verified: false,
    authority_flags: noAuthority(),
  };
}

export function bindExternalVerification(assuranceEnvelope, verification, options = {}) {
  if (!isObject(assuranceEnvelope)
    || assuranceEnvelope.schema !== 'agoragentic.transaction-assurance-envelope.v1') {
    throw new TypeError('assuranceEnvelope must use agoragentic.transaction-assurance-envelope.v1');
  }
  const suppliedActionReference = options.actionReference;
  const actionReference = actionReferenceForBinding(suppliedActionReference);
  const externalVerification = verification ?? notCheckedVerification(actionReference);
  if (!isObject(externalVerification)
    || externalVerification.schema !== 'agoragentic.external-verification.v1'
    || externalVerification.profile !== ANCHOR_PROFILE) {
    throw new TypeError('verification must use agoragentic.external-verification.v1');
  }
  if (!['not_checked', 'checked_match', 'checked_mismatch'].includes(externalVerification.status)) {
    throw new TypeError('verification status is unsupported');
  }
  if (externalVerification.action_reference !== actionReference.value) {
    throw new TypeError('external verification action reference mismatch');
  }
  if (verification !== undefined && verification !== null) {
    const verificationBinding = trustedExternalVerificationBindings.get(externalVerification);
    if (!verificationBinding || verificationBinding.result_hash !== sha256Ref(externalVerification)) {
      throw new TypeError('external verification must remain inside its trusted in-process verifier boundary');
    }
  }
  if (actionReference.recomputation === 'match') {
    const actionReferenceBinding = trustedActionReferenceBindings.get(suppliedActionReference);
    if (!actionReferenceBinding || actionReferenceBinding.result_hash !== sha256Ref(suppliedActionReference)) {
      throw new TypeError('matching action reference must remain inside its trusted recomputation boundary');
    }
  }
  if (externalVerification.status === 'checked_match' && actionReference.recomputation !== 'match') {
    throw new TypeError('checked external verification requires a recomputed matching action reference');
  }

  const result = structuredClone(assuranceEnvelope);
  if (result.external_action_refs !== undefined && !Array.isArray(result.external_action_refs)) {
    throw new TypeError('assuranceEnvelope.external_action_refs must be an array');
  }
  const actionRefRecord = {
    profile: actionReference.profile,
    value: actionReference.value,
    preimage_ref: actionReference.preimage_ref,
    recomputation: actionReference.recomputation,
    source_revision: actionReference.source_revision,
  };
  const existing = result.external_action_refs || [];
  const conflicting = existing.find((item) => (
    item?.profile === actionRefRecord.profile
      && item?.value === actionRefRecord.value
      && sha256Ref(item) !== sha256Ref(actionRefRecord)
  ));
  if (conflicting) throw new TypeError('conflicting external action-reference record');
  if (!existing.some((item) => sha256Ref(item) === sha256Ref(actionRefRecord))) {
    existing.push(actionRefRecord);
  }
  const priorEnvelopeHash = assuranceEnvelope.evidence?.envelope_hash || null;
  result.external_action_refs = existing;
  result.external_verification = {
    ...structuredClone(externalVerification),
    assurance_binding: {
      envelope_id: assuranceEnvelope.envelope_id || null,
      prior_envelope_hash: priorEnvelopeHash,
      binding_hash: sha256Ref({
        envelope_id: assuranceEnvelope.envelope_id || null,
        prior_envelope_hash: priorEnvelopeHash,
        action_reference: actionRefRecord,
        external_verification_hash: sha256Ref(externalVerification),
      }),
    },
  };
  result.evidence = isObject(result.evidence) ? result.evidence : {};
  result.evidence.envelope_hash = null;
  result.evidence.envelope_hash = computeEnvelopeHash(result);

  const envelopeBinding = trustedEnvelopeBinding(assuranceEnvelope);
  if (envelopeBinding) bindTrustedEnvelope(result, envelopeBinding);
  return result;
}
