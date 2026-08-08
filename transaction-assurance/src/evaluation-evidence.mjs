import {
  canonicalize,
  computeEnvelopeHash,
  sha256Ref,
} from './index.mjs';

const EVIDENCE_SCHEMA = 'agoragentic.transaction-evaluation-evidence.v1';
const SUMMARY_SCHEMA = 'agoragentic.transaction-evaluation-summary.v1';
const TYPES = new Set(['deterministic', 'model_judge', 'human_review', 'external_attestation']);
const RESULTS = new Set(['pass', 'fail', 'review', 'unknown']);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, { required = false, max = 2000 } = {}) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  return normalized ? normalized.slice(0, max) : null;
}

function list(value, field, { required = false, maxItems = 100 } = {}) {
  const source = value === undefined || value === null
    ? []
    : Array.isArray(value) ? value : [value];
  const normalized = [...new Set(
    source.map((item) => text(item, `${field} item`)).filter(Boolean),
  )].slice(0, maxItems);
  if (required && normalized.length === 0) throw new TypeError(`${field} requires at least one item`);
  return normalized;
}

function hashRef(value, field, { required = false } = {}) {
  const normalized = text(value, field, { required });
  if (!normalized) return null;
  if (!SHA256_PATTERN.test(normalized)) {
    throw new TypeError(`${field} must be a sha256:<64 lowercase hex characters> reference`);
  }
  return normalized;
}

function dateTime(value, field, { defaultNow = false } = {}) {
  const source = value ?? (defaultNow ? Date.now() : null);
  if (source === null || source === '') throw new TypeError(`${field} is required`);
  const parsed = new Date(source);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} must be a valid date-time`);
  return parsed.toISOString();
}

function normalizeHarness(value) {
  if (!isObject(value)) throw new TypeError('harness must be an object');
  return {
    id: text(value.id, 'harness.id', { required: true }),
    version: text(value.version, 'harness.version', { required: true }),
  };
}

function boundedScore(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 1) {
    throw new TypeError(`${field} must be between 0 and 1`);
  }
  return Number(number.toFixed(6));
}

function normalizeEvaluator(value, index) {
  if (!isObject(value)) throw new TypeError(`evaluators[${index}] must be an object`);
  const type = text(value.type, `evaluators[${index}].type`, { required: true });
  const result = text(value.result, `evaluators[${index}].result`, { required: true });
  if (!TYPES.has(type)) throw new TypeError(`unsupported evaluator type: ${type}`);
  if (!RESULTS.has(result)) throw new TypeError(`unsupported evaluator result: ${result}`);
  const modelRef = text(value.model_ref ?? value.model, `evaluators[${index}].model_ref`);
  if (type === 'model_judge' && !modelRef) {
    throw new TypeError(`evaluators[${index}].model_ref is required for model_judge`);
  }
  return {
    evaluator_id: text(value.evaluator_id ?? value.id, `evaluators[${index}].evaluator_id`, { required: true }),
    evaluator_version: text(value.evaluator_version ?? value.version, `evaluators[${index}].evaluator_version`, { required: true }),
    type,
    result,
    score: boundedScore(value.score, `evaluators[${index}].score`),
    model_ref: type === 'model_judge' ? modelRef : null,
    rubric_hash: hashRef(value.rubric_hash, `evaluators[${index}].rubric_hash`, { required: true }),
    evidence_refs: list(value.evidence_refs, `evaluators[${index}].evidence_refs`, { required: true }),
    notes: text(value.notes, `evaluators[${index}].notes`, { max: 1000 }),
  };
}

function authorityFlags() {
  return {
    evaluation_grants_authority: false,
    can_spend: false,
    can_fund_wallet: false,
    can_deploy: false,
    can_publish: false,
    can_change_trust: false,
    can_expand_scope: false,
  };
}

export function normalizeEvaluationEvidence(input = {}) {
  if (!isObject(input)) throw new TypeError('evaluation evidence must be an object');
  const evaluators = Array.isArray(input.evaluators)
    ? input.evaluators.map(normalizeEvaluator)
    : [];
  if (evaluators.length === 0) throw new TypeError('at least one evaluator is required');
  const environmentId = text(input.environment_id, 'environment_id', { required: true });
  const environmentVersion = text(input.environment_version, 'environment_version', { required: true });
  const environmentHash = hashRef(input.environment_hash, 'environment_hash', { required: true });
  const taskId = text(input.task_id, 'task_id', { required: true });
  const harness = normalizeHarness(input.harness);
  const traceHash = hashRef(input.trace_hash, 'trace_hash', { required: true });
  const artifactRefs = list(input.artifact_refs, 'artifact_refs');
  const observedAt = dateTime(input.observed_at, 'observed_at', { defaultNow: true });
  const evidence = {
    schema: EVIDENCE_SCHEMA,
    evidence_id: text(input.evidence_id) || `taev_${sha256Ref({
      environment: environmentId,
      version: environmentVersion,
      environmentHash,
      task: taskId,
      harness,
      traceHash,
      evaluators,
    }).slice(7, 23)}`,
    environment_id: environmentId,
    environment_version: environmentVersion,
    environment_hash: environmentHash,
    task_id: taskId,
    harness,
    evaluators,
    trace_hash: traceHash,
    artifact_refs: artifactRefs,
    observed_at: observedAt,
    redaction_state: 'not_verified',
    source_exactness: {
      original_trace_embedded: false,
      normalized_representation: true,
      normalization_lossless: false,
      verification_status: 'not_verified',
    },
    authority_flags: authorityFlags(),
    evidence_hash: null,
  };
  evidence.evidence_hash = computeEvaluationEvidenceHash(evidence);
  return evidence;
}

export function computeEvaluationEvidenceHash(evidence) {
  if (!isObject(evidence)) throw new TypeError('evaluation evidence must be an object');
  return sha256Ref({
    ...structuredClone(evidence),
    evidence_hash: null,
  });
}

export function verifyEvaluationEvidence(evidence) {
  if (!isObject(evidence) || evidence.schema !== EVIDENCE_SCHEMA) {
    throw new TypeError(`evaluation evidence must use ${EVIDENCE_SCHEMA}`);
  }
  hashRef(evidence.evidence_hash, 'evidence_hash', { required: true });
  if (evidence.evidence_hash !== computeEvaluationEvidenceHash(evidence)) {
    throw new TypeError('evaluation evidence hash mismatch');
  }
  const normalized = normalizeEvaluationEvidence(evidence);
  if (canonicalize(evidence) !== canonicalize(normalized)) {
    throw new TypeError('evaluation evidence is not canonical or contains unverified claims');
  }
  return normalized;
}

function normalizeOrVerify(entry) {
  return entry?.schema === EVIDENCE_SCHEMA
    ? verifyEvaluationEvidence(entry)
    : normalizeEvaluationEvidence(entry);
}

export function summarizeEvaluationEvidence(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const normalized = entries.map(normalizeOrVerify);
  const evaluators = normalized.flatMap((entry) => entry.evaluators || []);
  const deterministic = evaluators.filter((entry) => entry.type === 'deterministic');
  const failed = evaluators.filter((entry) => entry.result === 'fail');
  const review = evaluators.filter((entry) => entry.result === 'review');
  const scores = evaluators.map((entry) => entry.score).filter((value) => typeof value === 'number');
  let status = 'unknown';
  if (failed.length > 0) status = 'failed';
  else if (review.length > 0 || deterministic.length === 0) status = 'review';
  else if (evaluators.length > 0 && evaluators.every((entry) => entry.result === 'pass')) status = 'passed';

  return {
    schema: SUMMARY_SCHEMA,
    status,
    evidence_count: normalized.length,
    evaluator_count: evaluators.length,
    deterministic_evaluator_count: deterministic.length,
    failed_evaluator_ids: failed.map((entry) => entry.evaluator_id),
    review_evaluator_ids: review.map((entry) => entry.evaluator_id),
    mean_score: scores.length
      ? Number((scores.reduce((sum, score) => sum + score, 0) / scores.length).toFixed(6))
      : null,
    complete_transaction_verified: false,
    certification: false,
    authority_granted: false,
  };
}

export function attachEvaluationEvidence(envelope, entries) {
  if (!isObject(envelope) || envelope.schema !== 'agoragentic.transaction-assurance-envelope.v1') {
    throw new TypeError('envelope must use agoragentic.transaction-assurance-envelope.v1');
  }
  if (envelope.evidence?.envelope_hash !== computeEnvelopeHash(envelope)) {
    throw new TypeError('envelope hash mismatch');
  }
  const source = Array.isArray(entries) ? entries : [entries];
  if (source.length === 0) throw new TypeError('at least one evaluation evidence entry is required');
  const existing = Array.isArray(envelope.evaluation_evidence)
    ? envelope.evaluation_evidence.map(verifyEvaluationEvidence)
    : [];
  const normalized = source.map(normalizeOrVerify);
  const attached = structuredClone(envelope);
  attached.evaluation_evidence = [
    ...existing,
    ...normalized,
  ];
  attached.evaluation_summary = summarizeEvaluationEvidence(attached.evaluation_evidence);
  attached.updated_at = new Date().toISOString();
  attached.authority_flags = {
    ...(attached.authority_flags || {}),
    envelope_grants_authority: false,
  };
  if (!isObject(attached.evidence)) attached.evidence = {};
  attached.evidence.complete_chain_verified = false;
  attached.evidence.envelope_hash = null;
  attached.evidence.envelope_hash = computeEnvelopeHash(attached);
  return attached;
}
