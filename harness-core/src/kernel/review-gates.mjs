import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence, stableHash, stableId } from './events.mjs';
import { harnessDir, readJsonIfExists } from './state.mjs';

export const REVIEW_GATES_SCHEMA = 'agoragentic.harness.review-gates.v1';

const DECISIONS = Object.freeze(['approve', 'reject', 'needs_changes']);
const STATUS_BY_DECISION = Object.freeze({
  approve: 'approved',
  reject: 'rejected',
  needs_changes: 'needs_changes',
});

const BLOCKED_ACTIONS = Object.freeze([
  'agent_os_preview_submission',
  'marketplace_publication',
  'wallet_spend',
  'x402_route_activation',
  'hosted_runtime_provisioning',
  'provider_dispatch',
  'trust_mutation',
  'hosted_memory_write',
  'public_execute_or_invoke_mutation',
  'hermes_service_start',
  'ssh',
  'tunnel',
]);

const DEFAULT_GATES = Object.freeze({
  'listing-readiness': Object.freeze({
    gate_id: 'listing-readiness',
    label: 'Listing readiness maker-checker review',
    description: 'Local owner review gate before any Agent OS preview or listing publication handoff.',
    maker_checker_required: true,
    decision_options: DECISIONS,
    default_decision: 'needs_changes',
    required_evidence_refs: Object.freeze([
      Object.freeze({ id: 'local_proof', ref: '.agoragentic/local-proof.json', required: true }),
      Object.freeze({ id: 'local_receipt', ref: '.agoragentic/local-receipt.json', required: true }),
      Object.freeze({ id: 'agent_os_export', ref: '.agoragentic/agent-os-harness.json', required: true }),
      Object.freeze({ id: 'listing_readiness', ref: '.agoragentic/listing-readiness.json', required: true }),
    ]),
    blocked_actions: BLOCKED_ACTIONS,
  }),
});

export async function initReviewGates({ dir = process.cwd() } = {}) {
  const existing = await readReviewGates(dir);
  if (existing) return { artifact: existing, path: reviewGatesRelativePath(), created: false };

  const createdAt = new Date().toISOString();
  const artifact = {
    schema: REVIEW_GATES_SCHEMA,
    created_at: createdAt,
    updated_at: createdAt,
    mode: 'local_maker_checker_no_spend',
    gates: cloneDefaultGates(),
    requests: [],
    decisions: [],
    summary: buildSummary([], []),
    action_executed: false,
    authority_boundary: reviewAuthorityBoundary(),
  };
  await writeReviewGates(dir, artifact);
  return { artifact, path: reviewGatesRelativePath(), created: true };
}

export async function requestReview({
  dir = process.cwd(),
  gate_id,
  maker_label = 'local_maker',
} = {}) {
  if (!gate_id) throw new Error('review request requires --gate <id>');
  const { artifact } = await initReviewGates({ dir });
  const gate = artifact.gates?.[gate_id];
  if (!gate) throw new Error(`unknown review gate: ${gate_id}`);

  const createdAt = new Date().toISOString();
  const maker = {
    label: normalizeIdentityLabel(maker_label || 'local_maker'),
    role: 'maker',
  };
  const evidenceRefs = await materializeEvidenceRefs(dir, gate.required_evidence_refs || []);
  const reviewId = stableId('review', `${gate_id}:${maker.label}:${createdAt}:${JSON.stringify(evidenceRefs)}`);
  const request = {
    schema: 'agoragentic.harness.review-request.v1',
    review_id: reviewId,
    gate_id,
    created_at: createdAt,
    status: 'pending',
    maker,
    checker_required: true,
    checker_must_differ_from_maker: true,
    required_evidence_refs: evidenceRefs,
    missing_required_evidence_refs: evidenceRefs.filter((entry) => entry.required && !entry.present).map((entry) => entry.id),
    blocked_actions: [...(gate.blocked_actions || [])],
    decision: null,
    latest_decision_ref: null,
    action_executed: false,
    authority_boundary: reviewAuthorityBoundary(),
  };

  artifact.requests.push(request);
  artifact.updated_at = createdAt;
  artifact.summary = buildSummary(artifact.requests, artifact.decisions);
  await writeReviewGates(dir, artifact);
  return { request, artifact, path: reviewGatesRelativePath() };
}

export async function decideReview({
  dir = process.cwd(),
  review_id,
  decision,
  checker_label,
  note = '',
} = {}) {
  if (!review_id) throw new Error('review decide requires a review_id');
  if (!DECISIONS.includes(decision)) {
    throw new Error('decision must be approve, reject, or needs_changes');
  }
  if (!checker_label) throw new Error('review decide requires --checker <label>');

  const artifact = await readReviewGates(dir);
  if (!artifact) throw new Error('review gates are not initialized');
  const request = artifact.requests.find((entry) => entry.review_id === review_id);
  if (!request) throw new Error(`review request not found: ${review_id}`);

  const checker = {
    label: normalizeIdentityLabel(checker_label),
    role: 'checker',
  };
  if (sameIdentityLabel(checker.label, request.maker?.label)) {
    throw new Error('checker_must_differ_from_maker');
  }

  const decidedAt = new Date().toISOString();
  const decisionId = stableId('review_decision', `${review_id}:${decision}:${checker.label}:${decidedAt}`);
  const decisionRef = `${reviewGatesRelativePath()}#decisions/${decisionId}`;
  const payload = {
    schema: 'agoragentic.harness.review-decision.v1',
    decision_id: decisionId,
    review_id,
    gate_id: request.gate_id,
    decided_at: decidedAt,
    decision,
    status: STATUS_BY_DECISION[decision],
    maker: request.maker,
    checker,
    checker_different_from_maker: true,
    note: sanitizeForPublicEvidence(note, { maxStringLength: 240 }),
    required_evidence_refs: request.required_evidence_refs || [],
    blocked_actions: request.blocked_actions || [],
    action_executed: false,
    decision_ref: decisionRef,
    authority_boundary: reviewAuthorityBoundary(),
  };

  artifact.decisions.push(payload);
  request.status = payload.status;
  request.decision = decision;
  request.checker = checker;
  request.decided_at = decidedAt;
  request.latest_decision_ref = decisionRef;
  request.action_executed = false;
  artifact.updated_at = decidedAt;
  artifact.summary = buildSummary(artifact.requests, artifact.decisions);
  await writeReviewGates(dir, artifact);
  return { decision: payload, artifact, path: reviewGatesRelativePath() };
}

export async function listReviewGates(dir = process.cwd()) {
  const artifact = await readReviewGates(dir);
  return summarizeReviewGates(artifact);
}

export async function reviewGateStatus(dir = process.cwd()) {
  const artifact = await readReviewGates(dir);
  const summary = summarizeReviewGates(artifact);
  return {
    present: Boolean(artifact),
    path: artifact ? reviewGatesRelativePath() : null,
    gates: summary.gates,
    open_requests: summary.open_requests,
    required_checker_decisions: summary.required_checker_decisions,
    blocked_actions: summary.blocked_actions,
    latest_decision_refs: summary.latest_decision_refs,
    latest_decisions: summary.latest_decisions,
    action_executed: false,
    authority_boundary: reviewAuthorityBoundary(),
  };
}

export async function readReviewGates(dir = process.cwd()) {
  return readJsonIfExists(reviewGatesPath(dir));
}

function summarizeReviewGates(artifact) {
  if (!artifact) {
    return {
      present: false,
      path: null,
      gates: [],
      requests: [],
      open_requests: [],
      required_checker_decisions: [],
      latest_decisions: [],
      latest_decision_refs: [],
      blocked_actions: [],
      summary: buildSummary([], []),
      action_executed: false,
      authority_boundary: reviewAuthorityBoundary(),
    };
  }

  const latestByReview = latestDecisionsByReview(artifact.decisions || []);
  const requests = (artifact.requests || []).map((request) => ({
    ...request,
    latest_decision_ref: request.latest_decision_ref || latestByReview.get(request.review_id)?.decision_ref || null,
  }));
  const openRequests = requests.filter((request) => request.status === 'pending');
  const latestDecisions = [...latestByReview.values()].sort((a, b) => String(b.decided_at).localeCompare(String(a.decided_at)));
  return {
    present: true,
    path: reviewGatesRelativePath(),
    gates: Object.values(artifact.gates || {}),
    requests,
    open_requests: openRequests,
    required_checker_decisions: openRequests.map((request) => ({
      review_id: request.review_id,
      gate_id: request.gate_id,
      maker_label: request.maker?.label || null,
      required_checker: `checker label must differ from maker label ${request.maker?.label || 'unknown'}`,
      required_evidence_refs: request.required_evidence_refs || [],
      blocked_actions: request.blocked_actions || [],
      action_executed: false,
    })),
    latest_decisions: latestDecisions,
    latest_decision_refs: latestDecisions.map((entry) => entry.decision_ref),
    blocked_actions: unique(openRequests.flatMap((request) => request.blocked_actions || [])),
    summary: buildSummary(requests, artifact.decisions || []),
    action_executed: false,
    authority_boundary: reviewAuthorityBoundary(),
  };
}

function latestDecisionsByReview(decisions) {
  const latest = new Map();
  for (const decision of decisions) {
    const previous = latest.get(decision.review_id);
    if (!previous || String(decision.decided_at).localeCompare(String(previous.decided_at)) > 0) {
      latest.set(decision.review_id, decision);
    }
  }
  return latest;
}

async function materializeEvidenceRefs(dir, refs) {
  const root = path.resolve(dir);
  const out = [];
  for (const ref of refs) {
    const relPath = String(ref.ref || '').replace(/\\/g, '/');
    const filePath = path.join(root, relPath);
    let text = null;
    try {
      text = await fs.readFile(filePath, 'utf8');
    } catch {
      text = null;
    }
    out.push({
      id: ref.id,
      ref: relPath,
      required: Boolean(ref.required),
      present: text !== null,
      hash: text === null ? null : stableHash(text),
      bytes: text === null ? 0 : Buffer.byteLength(text),
      raw_content_inlined: false,
    });
  }
  return out;
}

async function writeReviewGates(dir, artifact) {
  await fs.mkdir(harnessDir(dir), { recursive: true });
  await fs.writeFile(reviewGatesPath(dir), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

function reviewGatesPath(dir) {
  return path.join(harnessDir(dir), 'review-gates.json');
}

function reviewGatesRelativePath() {
  return '.agoragentic/review-gates.json';
}

function cloneDefaultGates() {
  return Object.fromEntries(Object.entries(DEFAULT_GATES).map(([id, gate]) => [
    id,
    {
      ...gate,
      decision_options: [...gate.decision_options],
      required_evidence_refs: gate.required_evidence_refs.map((entry) => ({ ...entry })),
      blocked_actions: [...gate.blocked_actions],
      authority_boundary: reviewAuthorityBoundary(),
    },
  ]));
}

function buildSummary(requests, decisions) {
  return {
    request_count: requests.length,
    open_request_count: requests.filter((entry) => entry.status === 'pending').length,
    decision_count: decisions.length,
    latest_decision_ref: decisions.length ? decisions[decisions.length - 1].decision_ref : null,
    action_executed: false,
  };
}

function reviewAuthorityBoundary() {
  return authorityBoundary({
    hosted_approval_flow: false,
    hosted_memory_write: false,
    hermes_service_start: false,
    ssh: false,
    tunnel: false,
  });
}

function normalizeIdentityLabel(value) {
  const label = String(value || '').trim();
  if (!label) throw new Error('identity label is required');
  return sanitizeForPublicEvidence(label, { maxStringLength: 80 });
}

function sameIdentityLabel(a, b) {
  return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
