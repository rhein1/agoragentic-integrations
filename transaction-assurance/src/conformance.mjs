import { readFile } from 'node:fs/promises';

import { canonicalize, sha256Ref } from './index.mjs';
import { PROTOCOL_ADAPTER_PINS } from './protocol-adapters.mjs';

export const CONFORMANCE_SCHEMA = 'agoragentic.transaction-assurance-conformance.v1';
export const CONFORMANCE_REPORT_SCHEMA = 'agoragentic.transaction-assurance-conformance-report.v1';
export const CONFORMANCE_RECEIPT_SCHEMA = 'agoragentic.transaction-assurance-conformance-receipt.v1';

const DECISIONS = new Set(['pass', 'deny', 'review']);
const VERIFICATION_STATES = new Set(['verified', 'unverified', 'unknown']);
const REVOCATION_STATES = new Set(['active', 'revoked', 'not_checked', 'unknown']);
const OUTCOME_STATES = new Set(['passed', 'failed', 'partial', 'not_checked']);
const RECONCILIATION_STATES = new Set([
  'complete',
  'refunded',
  'refund_pending',
  'dispute_pending',
  'dispute_resolved',
  'none',
]);
const TOKEN = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const MAX_VECTORS = 128;

function isObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function object(value, field) {
  if (!isObject(value)) throw new TypeError(`${field} must be an object`);
  return value;
}

function exactKeys(value, keys, field) {
  object(value, field);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (canonicalize(actual) !== canonicalize(expected)) {
    throw new TypeError(`${field} must contain exactly: ${expected.join(', ')}`);
  }
  return value;
}

function text(value, field, { max = 500, token = false } = {}) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${field} must be a non-empty string of at most ${max} characters`);
  }
  if (token && !TOKEN.test(value)) throw new TypeError(`${field} must be a bounded token`);
  return value;
}

function bool(value, field) {
  if (typeof value !== 'boolean') throw new TypeError(`${field} must be boolean`);
  return value;
}

function integer(value, field) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${field} must be a non-negative integer`);
  return value;
}

function enumeration(value, field, values) {
  text(value, field, { token: true });
  if (!values.has(value)) throw new TypeError(`${field} is unsupported`);
  return value;
}

function uniqueTokens(value, field, { max = 128 } = {}) {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new TypeError(`${field} must contain 1-${max} items`);
  }
  const result = value.map((item, index) => text(item, `${field}[${index}]`, { token: true }));
  if (new Set(result).size !== result.length) throw new TypeError(`${field} must be unique`);
  return result;
}

function clone(value) {
  return structuredClone(value);
}

function merge(base, patch) {
  if (!isObject(patch)) return clone(patch);
  const output = isObject(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    output[key] = isObject(value) ? merge(output[key], value) : clone(value);
  }
  return output;
}

function validateBooleanRecord(value, keys, field) {
  exactKeys(value, keys, field);
  for (const key of keys) bool(value[key], `${field}.${key}`);
}

export function validateConformanceInput(input) {
  exactKeys(input, [
    'schema',
    'protocol',
    'authority',
    'terms',
    'limits',
    'payment',
    'settlement',
    'execution',
    'outcome',
    'reconciliation',
    'privacy',
  ], 'input');
  if (input.schema !== CONFORMANCE_SCHEMA) throw new TypeError('input.schema is unsupported');

  exactKeys(input.protocol, ['adapter_id', 'source_version'], 'input.protocol');
  text(input.protocol.adapter_id, 'input.protocol.adapter_id', { token: true });
  text(input.protocol.source_version, 'input.protocol.source_version', { max: 128 });

  exactKeys(input.authority, [
    'present',
    'verification',
    'revocation',
    'principal_match',
    'audience_match',
    'agent_match',
    'expired',
  ], 'input.authority');
  bool(input.authority.present, 'input.authority.present');
  enumeration(input.authority.verification, 'input.authority.verification', VERIFICATION_STATES);
  enumeration(input.authority.revocation, 'input.authority.revocation', REVOCATION_STATES);
  bool(input.authority.principal_match, 'input.authority.principal_match');
  bool(input.authority.audience_match, 'input.authority.audience_match');
  bool(input.authority.agent_match, 'input.authority.agent_match');
  bool(input.authority.expired, 'input.authority.expired');

  validateBooleanRecord(input.terms, [
    'merchant_match',
    'seller_match',
    'category_match',
    'action_match',
    'rail_match',
    'currency_match',
    'quote_match',
    'terms_match',
  ], 'input.terms');
  validateBooleanRecord(input.limits, [
    'per_action_within_limit',
    'daily_within_limit',
    'total_within_limit',
  ], 'input.limits');
  validateBooleanRecord(input.payment, [
    'identifier_present',
    'identifier_reused',
    'replay_detected',
    'evidence_replayed',
  ], 'input.payment');
  validateBooleanRecord(input.settlement, ['observed', 'verified', 'final'], 'input.settlement');
  validateBooleanRecord(input.execution, ['attempted', 'succeeded', 'delivery_observed'], 'input.execution');

  exactKeys(input.outcome, ['validation'], 'input.outcome');
  enumeration(input.outcome.validation, 'input.outcome.validation', OUTCOME_STATES);
  exactKeys(input.reconciliation, ['status'], 'input.reconciliation');
  enumeration(input.reconciliation.status, 'input.reconciliation.status', RECONCILIATION_STATES);
  validateBooleanRecord(input.privacy, [
    'raw_secret_exposed',
    'private_key_exposed',
    'payment_credential_exposed',
    'raw_prompt_exposed',
    'raw_tool_output_exposed',
    'private_owner_data_exposed',
  ], 'input.privacy');
  return input;
}

export function validateConformanceManifest(manifest) {
  exactKeys(manifest, [
    'schema',
    'suite_name',
    'suite_version',
    'released_at',
    'profiles',
    'protocol_adapters',
    'vector_set',
    'claim_boundary',
    'explicit_exclusions',
    'network_required',
    'spend_authority',
  ], 'manifest');
  if (manifest.schema !== 'agoragentic.transaction-assurance-conformance-manifest.v1') {
    throw new TypeError('manifest.schema is unsupported');
  }
  text(manifest.suite_name, 'manifest.suite_name', { max: 200 });
  text(manifest.suite_version, 'manifest.suite_version', { max: 64 });
  if (Number.isNaN(Date.parse(manifest.released_at))) throw new TypeError('manifest.released_at must be a date-time');
  uniqueTokens(manifest.profiles, 'manifest.profiles', { max: 16 });
  if (!Array.isArray(manifest.protocol_adapters) || manifest.protocol_adapters.length < 4) {
    throw new TypeError('manifest.protocol_adapters must contain at least four adapters');
  }
  const ids = new Set();
  for (const [index, adapter] of manifest.protocol_adapters.entries()) {
    exactKeys(adapter, ['id', 'version', 'revision', 'source'], `manifest.protocol_adapters[${index}]`);
    const id = text(adapter.id, `manifest.protocol_adapters[${index}].id`, { token: true });
    if (ids.has(id)) throw new TypeError('manifest protocol adapter IDs must be unique');
    ids.add(id);
    const pin = PROTOCOL_ADAPTER_PINS[id];
    if (!pin || adapter.version !== pin.version || adapter.revision !== pin.revision || adapter.source !== pin.source) {
      throw new TypeError(`manifest protocol adapter ${id} is not pinned to the package source`);
    }
  }
  text(manifest.vector_set, 'manifest.vector_set', { max: 300 });
  text(manifest.claim_boundary, 'manifest.claim_boundary', { max: 1000 });
  uniqueTokens(manifest.explicit_exclusions, 'manifest.explicit_exclusions', { max: 32 });
  if (manifest.network_required !== false || manifest.spend_authority !== false) {
    throw new TypeError('manifest must remain offline and no-spend');
  }
  return manifest;
}

export function validateConformanceVectorSet(vectorSet, manifest) {
  validateConformanceManifest(manifest);
  exactKeys(vectorSet, ['schema', 'suite_version', 'base_input', 'vectors'], 'vector_set');
  if (vectorSet.schema !== 'agoragentic.transaction-assurance-conformance-vectors.v1') {
    throw new TypeError('vector_set.schema is unsupported');
  }
  if (vectorSet.suite_version !== manifest.suite_version) throw new TypeError('vector suite version mismatch');
  validateConformanceInput(vectorSet.base_input);
  if (!Array.isArray(vectorSet.vectors) || vectorSet.vectors.length === 0 || vectorSet.vectors.length > MAX_VECTORS) {
    throw new TypeError(`vector_set.vectors must contain 1-${MAX_VECTORS} vectors`);
  }
  const ids = new Set();
  const profiles = new Set(manifest.profiles);
  const adapters = new Set(manifest.protocol_adapters.map((item) => item.id));
  const coveredProfiles = new Set();
  const coveredAdapters = new Set();
  for (const [index, vector] of vectorSet.vectors.entries()) {
    exactKeys(vector, [
      'id',
      'profile',
      'adapter_id',
      'source_version',
      'description',
      'input_patch',
      'expected',
    ], `vector_set.vectors[${index}]`);
    const id = text(vector.id, `vector_set.vectors[${index}].id`, { token: true });
    if (ids.has(id)) throw new TypeError('vector IDs must be unique');
    ids.add(id);
    if (!profiles.has(vector.profile)) throw new TypeError(`vector ${id} uses an unknown profile`);
    if (!adapters.has(vector.adapter_id)) throw new TypeError(`vector ${id} uses an unknown adapter`);
    coveredProfiles.add(vector.profile);
    coveredAdapters.add(vector.adapter_id);
    text(vector.source_version, `vector ${id}.source_version`, { max: 128 });
    text(vector.description, `vector ${id}.description`, { max: 500 });
    object(vector.input_patch, `vector ${id}.input_patch`);
    exactKeys(vector.expected, ['decision', 'code'], `vector ${id}.expected`);
    enumeration(vector.expected.decision, `vector ${id}.expected.decision`, DECISIONS);
    text(vector.expected.code, `vector ${id}.expected.code`, { token: true });
    materializeVectorInput(vectorSet.base_input, vector);
  }
  if (canonicalize([...coveredProfiles].sort()) !== canonicalize([...profiles].sort())) {
    throw new TypeError('vector set must cover every declared profile');
  }
  if (canonicalize([...coveredAdapters].sort()) !== canonicalize([...adapters].sort())) {
    throw new TypeError('vector set must cover every pinned adapter');
  }
  return vectorSet;
}

export function materializeVectorInput(baseInput, vector) {
  const input = merge(baseInput, vector.input_patch);
  input.protocol = {
    adapter_id: vector.adapter_id,
    source_version: vector.source_version,
  };
  return validateConformanceInput(input);
}

function result(decision, code) {
  return Object.freeze({ decision, code });
}

export function evaluateReferenceVector(input) {
  validateConformanceInput(input);
  const pin = PROTOCOL_ADAPTER_PINS[input.protocol.adapter_id];
  if (!pin || input.protocol.source_version !== pin.version) return result('deny', 'unsupported_protocol_version');

  if (!input.authority.present) return result('deny', 'authority_absent');
  if (input.authority.verification === 'unknown') return result('review', 'authority_verification_unknown');
  if (input.authority.verification !== 'verified') return result('review', 'authority_unverified');
  if (input.authority.revocation === 'revoked') return result('deny', 'authority_revoked');
  if (input.authority.revocation !== 'active') return result('review', 'authority_revocation_unknown');
  if (input.authority.expired) return result('deny', 'authority_expired');
  if (!input.authority.principal_match) return result('deny', 'authority_wrong_principal');
  if (!input.authority.audience_match) return result('deny', 'authority_wrong_audience');
  if (!input.authority.agent_match) return result('deny', 'authority_wrong_agent');

  for (const [field, code] of [
    ['merchant_match', 'merchant_mismatch'],
    ['seller_match', 'seller_mismatch'],
    ['category_match', 'category_mismatch'],
    ['action_match', 'action_mismatch'],
    ['rail_match', 'rail_mismatch'],
    ['currency_match', 'currency_mismatch'],
    ['quote_match', 'quote_changed'],
    ['terms_match', 'terms_changed'],
  ]) {
    if (!input.terms[field]) return result('deny', code);
  }
  for (const [field, code] of [
    ['per_action_within_limit', 'per_action_limit_exceeded'],
    ['daily_within_limit', 'daily_limit_exceeded'],
    ['total_within_limit', 'total_limit_exceeded'],
  ]) {
    if (!input.limits[field]) return result('deny', code);
  }

  if (!input.payment.identifier_present) return result('deny', 'payment_identifier_missing');
  if (input.payment.identifier_reused) return result('deny', 'payment_identifier_reused');
  if (input.payment.replay_detected) return result('deny', 'paid_retry_replay_detected');
  if (input.payment.evidence_replayed) return result('deny', 'evidence_replayed');
  if (!input.settlement.observed) return result('review', 'payment_not_observed');
  if (!input.settlement.verified) return result('deny', 'settlement_unverified');
  if (!input.settlement.final) return result('review', 'settlement_not_final');
  if (!input.execution.attempted) return result('review', 'execution_not_observed');
  if (!input.execution.succeeded) return result('deny', 'execution_failed_after_payment');
  if (!input.execution.delivery_observed) return result('review', 'delivery_missing_after_payment');

  if (input.outcome.validation === 'not_checked') return result('review', 'outcome_not_validated');
  if (input.outcome.validation === 'failed') return result('deny', 'outcome_validation_failed');
  if (input.outcome.validation === 'partial') return result('review', 'partial_fulfillment');

  if (Object.entries(input.privacy).some(([, exposed]) => exposed)) {
    const field = Object.entries(input.privacy).find(([, exposed]) => exposed)[0];
    return result('deny', `privacy_${field}`);
  }

  if (input.reconciliation.status === 'refund_pending') return result('review', 'refund_pending');
  if (input.reconciliation.status === 'dispute_pending') return result('review', 'dispute_pending');
  if (input.reconciliation.status === 'none') return result('review', 'reconciliation_incomplete');
  if (input.reconciliation.status === 'refunded') return result('pass', 'reconciled_refunded');
  if (input.reconciliation.status === 'dispute_resolved') return result('pass', 'reconciled_dispute_resolved');
  return result('pass', 'complete_chain_verified');
}

function validateEvaluatorResult(value, field) {
  exactKeys(value, ['decision', 'code'], field);
  enumeration(value.decision, `${field}.decision`, DECISIONS);
  text(value.code, `${field}.code`, { token: true });
  return value;
}

export async function runConformanceSuite({
  manifest,
  vectorSet,
  evaluate = ({ input }) => evaluateReferenceVector(input),
  target,
}) {
  validateConformanceVectorSet(vectorSet, manifest);
  if (typeof evaluate !== 'function') throw new TypeError('evaluate must be a function');
  exactKeys(target, ['name', 'version', 'commit'], 'target');
  text(target.name, 'target.name', { max: 200 });
  text(target.version, 'target.version', { max: 128 });
  text(target.commit, 'target.commit', { max: 128 });

  const results = [];
  for (const vector of vectorSet.vectors) {
    const input = materializeVectorInput(vectorSet.base_input, vector);
    const actual = await evaluate(Object.freeze({
      vector: Object.freeze(clone(vector)),
      input: Object.freeze(clone(input)),
    }));
    validateEvaluatorResult(actual, `result for ${vector.id}`);
    const passed = actual.decision === vector.expected.decision && actual.code === vector.expected.code;
    results.push({
      id: vector.id,
      profile: vector.profile,
      adapter_id: vector.adapter_id,
      source_version: vector.source_version,
      input_hash: sha256Ref(input),
      expected: clone(vector.expected),
      actual: clone(actual),
      passed,
    });
  }

  const passed = results.filter((item) => item.passed).length;
  const body = {
    schema: CONFORMANCE_REPORT_SCHEMA,
    suite_version: manifest.suite_version,
    target: clone(target),
    manifest_hash: sha256Ref(manifest),
    vector_set_hash: sha256Ref(vectorSet),
    total: results.length,
    passed,
    failed: results.length - passed,
    all_passed: passed === results.length,
    profiles_tested: [...new Set(results.map((item) => item.profile))].sort(),
    protocol_adapters_tested: manifest.protocol_adapters.map((adapter) => ({
      id: adapter.id,
      version: adapter.version,
      revision: adapter.revision,
    })),
    results,
    network_used_by_suite: false,
    spend_authority_granted: false,
  };
  return { ...body, report_hash: sha256Ref(body) };
}

export function validateConformanceReport({ manifest, vectorSet, report }) {
  validateConformanceVectorSet(vectorSet, manifest);
  exactKeys(report, [
    'schema',
    'suite_version',
    'target',
    'manifest_hash',
    'vector_set_hash',
    'total',
    'passed',
    'failed',
    'all_passed',
    'profiles_tested',
    'protocol_adapters_tested',
    'results',
    'network_used_by_suite',
    'spend_authority_granted',
    'report_hash',
  ], 'report');
  if (report.schema !== CONFORMANCE_REPORT_SCHEMA) throw new TypeError('report.schema is unsupported');
  if (report.suite_version !== manifest.suite_version) throw new TypeError('report suite version mismatch');
  exactKeys(report.target, ['name', 'version', 'commit'], 'report.target');
  text(report.target.name, 'report.target.name', { max: 200 });
  text(report.target.version, 'report.target.version', { max: 128 });
  text(report.target.commit, 'report.target.commit', { max: 128 });
  if (report.manifest_hash !== sha256Ref(manifest) || report.vector_set_hash !== sha256Ref(vectorSet)) {
    throw new TypeError('report input hash mismatch');
  }
  if (!Array.isArray(report.results) || report.results.length !== vectorSet.vectors.length) {
    throw new TypeError('report must contain exactly one result per vector');
  }
  const vectorMap = new Map(vectorSet.vectors.map((vector) => [vector.id, vector]));
  const resultIds = new Set();
  for (const [index, item] of report.results.entries()) {
    exactKeys(item, [
      'id',
      'profile',
      'adapter_id',
      'source_version',
      'input_hash',
      'expected',
      'actual',
      'passed',
    ], `report.results[${index}]`);
    const vector = vectorMap.get(item.id);
    if (!vector || resultIds.has(item.id)) throw new TypeError('report result IDs must match vectors exactly once');
    resultIds.add(item.id);
    if (item.profile !== vector.profile
      || item.adapter_id !== vector.adapter_id
      || item.source_version !== vector.source_version) {
      throw new TypeError(`report result metadata mismatch for ${item.id}`);
    }
    if (item.input_hash !== sha256Ref(materializeVectorInput(vectorSet.base_input, vector))) {
      throw new TypeError(`report input hash mismatch for ${item.id}`);
    }
    if (canonicalize(item.expected) !== canonicalize(vector.expected)) {
      throw new TypeError(`report expected result mismatch for ${item.id}`);
    }
    validateEvaluatorResult(item.actual, `report actual result for ${item.id}`);
    bool(item.passed, `report passed for ${item.id}`);
    const shouldPass = item.actual.decision === vector.expected.decision
      && item.actual.code === vector.expected.code;
    if (item.passed !== shouldPass) throw new TypeError(`report pass flag mismatch for ${item.id}`);
  }
  const expectedProfiles = [...new Set(vectorSet.vectors.map((item) => item.profile))].sort();
  if (canonicalize(report.profiles_tested) !== canonicalize(expectedProfiles)) {
    throw new TypeError('report profile coverage mismatch');
  }
  const expectedAdapters = manifest.protocol_adapters.map((adapter) => ({
    id: adapter.id,
    version: adapter.version,
    revision: adapter.revision,
  }));
  if (canonicalize(report.protocol_adapters_tested) !== canonicalize(expectedAdapters)) {
    throw new TypeError('report adapter coverage mismatch');
  }
  const passed = report.results.filter((item) => item.passed).length;
  if (integer(report.total, 'report.total') !== report.results.length
    || integer(report.passed, 'report.passed') !== passed
    || integer(report.failed, 'report.failed') !== report.results.length - passed
    || bool(report.all_passed, 'report.all_passed') !== (passed === report.results.length)) {
    throw new TypeError('report counts are inconsistent');
  }
  if (report.network_used_by_suite !== false || report.spend_authority_granted !== false) {
    throw new TypeError('report authority boundary mismatch');
  }
  const body = { ...report };
  delete body.report_hash;
  if (!HASH.test(report.report_hash || '') || sha256Ref(body) !== report.report_hash) {
    throw new TypeError('report hash mismatch');
  }
  return report;
}

export function buildConformanceReceipt({ manifest, vectorSet, report }) {
  validateConformanceReport({ manifest, vectorSet, report });
  const body = {
    schema: CONFORMANCE_RECEIPT_SCHEMA,
    suite_version: manifest.suite_version,
    target: clone(report.target),
    manifest_hash: report.manifest_hash,
    vector_set_hash: report.vector_set_hash,
    report_hash: report.report_hash,
    total: integer(report.total, 'report.total'),
    passed: integer(report.passed, 'report.passed'),
    failed: integer(report.failed, 'report.failed'),
    all_passed: bool(report.all_passed, 'report.all_passed'),
    profiles_tested: clone(report.profiles_tested),
    protocol_adapters_tested: clone(report.protocol_adapters_tested),
    test_hashes: report.results.map((item) => ({
      id: item.id,
      input_hash: item.input_hash,
      expected_hash: sha256Ref(item.expected),
      actual_hash: sha256Ref(item.actual),
      passed: item.passed,
    })),
    explicit_exclusions: clone(manifest.explicit_exclusions),
    claim_boundary: manifest.claim_boundary,
    network_used_by_suite: false,
    spend_authority_granted: false,
    certification_granted: false,
  };
  return { ...body, receipt_hash: sha256Ref(body) };
}

export function verifyConformanceReceipt({ manifest, vectorSet, report, receipt }) {
  try {
    const expected = buildConformanceReceipt({ manifest, vectorSet, report });
    return {
      verified: canonicalize(expected) === canonicalize(receipt),
      receipt_hash: expected.receipt_hash,
    };
  } catch (error) {
    return { verified: false, error: error.message };
  }
}

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function renderConformanceJUnit(report) {
  if (report?.schema !== CONFORMANCE_REPORT_SCHEMA) throw new TypeError('report is required');
  const cases = report.results.map((item) => {
    const failure = item.passed
      ? ''
      : `<failure message="${xml(`${item.actual.decision}:${item.actual.code}`)}">expected ${xml(`${item.expected.decision}:${item.expected.code}`)}</failure>`;
    return `  <testcase classname="transaction-assurance.${xml(item.profile)}" name="${xml(item.id)}">${failure}</testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="Agoragentic Transaction Assurance" tests="${report.total}" failures="${report.failed}" errors="0" time="0">`,
    ...cases,
    '</testsuite>',
    '',
  ].join('\n');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}
