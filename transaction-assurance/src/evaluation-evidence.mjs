import { sha256Ref } from './index.mjs';

const TYPES = new Set(['deterministic', 'model_judge', 'human_review', 'external_attestation']);
const RESULTS = new Set(['pass', 'fail', 'review', 'unknown']);
const REDACTION_STATES = new Set(['public_safe', 'private_ref_only', 'unknown']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function text(value, field, { required = false, max = 2000 } = {}) {
  const normalized = value === undefined || value === null ? '' : String(value).trim();
  if (required && !normalized) throw new TypeError(`${field} is required`);
  return normalized ? normalized.slice(0, max) : null;
}

function list(value, maxItems = 100) {
  if (value === undefined || value === null) return [];
  const source = Array.isArray(value) ? value : [value];
  return [...new Set(source.map((item) => text(item, 'list item')).filter(Boolean))].slice(0, maxItems);
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
  return {
    evaluator_id: text(value.evaluator_id ?? value.id, `evaluators[${index}].evaluator_id`, { required: true }),
    evaluator_version: text(value.evaluator_version ?? value.version, `evaluators[${index}].evaluator_version`, { required: true }),
    type,
    result,
    score: boundedScore(value.score, `evaluators[${index}].score`),
    model_ref: type === 'model_judge' ? text(value.model_ref ?? value.model) : null,
    rubric_hash: text(value.rubric_hash),
    evidence_refs: list(value.evidence_refs),
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
  const redactionState = text(input.redaction_state, 'redaction_state') || 'unknown';
  if (!REDACTION_STATES.has(redactionState)) {
    throw new TypeError(`unsupported redaction_state: ${redactionState}`);
  }
  const evidence = {
    schema: 'agoragentic.transaction-evaluation-evidence.v1',
    evidence_id: text(input.evidence_id) || `taev_${sha256Ref({
      environment: input.environment_id,
      version: input.environment_version,
      task: input.task_id,
      evaluators,
    }).slice(7, 23)}`,
    environment_id: text(input.environment_id, 'environment_id', { required: true }),
    environment_version: text(input.environment_version, 'environment_version', { required: true }),
    environment_hash: text(input.environment_hash),
    task_id: text(input.task_id, 'task_id', { required: true }),
    harness: {
      id: text(input.harness?.id),
      version: text(input.harness?.version),
    },
    evaluators,
    trace_hash: text(input.trace_hash),
    artifact_refs: list(input.artifact_refs),
    observed_at: new Date(input.observed_at || Date.now()).toISOString(),
    redaction_state: redactionState,
    source_exactness: {
      original_trace_embedded: false,
      normalized_representation: true,
      normalization_lossless: input.normalization_lossless === true,
    },
    authority_flags: authorityFlags(),
  };
  evidence.evidence_hash = sha256Ref(evidence);
  return evidence;
}

export function summarizeEvaluationEvidence(entries = []) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const normalized = entries.map((entry) => (
    entry?.schema === 'agoragentic.transaction-evaluation-evidence.v1'
      ? entry
      : normalizeEvaluationEvidence(entry)
  ));
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
    schema: 'agoragentic.transaction-evaluation-summary.v1',
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
  const source = Array.isArray(entries) ? entries : [entries];
  const normalized = source.map((entry) => normalizeEvaluationEvidence(entry));
  const attached = structuredClone(envelope);
  attached.evaluation_evidence = [
    ...(Array.isArray(attached.evaluation_evidence) ? attached.evaluation_evidence : []),
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
  delete attached.evidence.envelope_hash;
  attached.evidence.envelope_hash = sha256Ref(attached);
  return attached;
}
