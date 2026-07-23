import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence, stableHash, stableId } from './events.mjs';
import { harnessDir, latestRunState, readJsonIfExists } from './state.mjs';

export const IMPROVEMENT_CANDIDATES_SCHEMA = 'agoragentic.harness.improvement-candidates.v1';
export const OWNER_INBOX_SCHEMA = 'agoragentic.harness.owner-inbox.v1';

const DECISIONS = Object.freeze(['accept', 'reject', 'defer']);
const STATUS_BY_DECISION = Object.freeze({
  accept: 'accepted',
  reject: 'rejected',
  defer: 'deferred',
});

export async function suggestImprovements({ dir = process.cwd() } = {}) {
  const existing = await readImprovementCandidates(dir);
  const now = new Date().toISOString();
  const artifact = existing || {
    schema: IMPROVEMENT_CANDIDATES_SCHEMA,
    created_at: now,
    updated_at: now,
    mode: 'local_self_improvement_candidates_no_execution',
    candidates: [],
    decisions: [],
    summary: buildSummary([], []),
    action_executed: false,
    authority_boundary: improvementAuthorityBoundary(),
  };

  const existingById = new Map((artifact.candidates || []).map((candidate) => [candidate.candidate_id, candidate]));
  const suggestions = await deriveSuggestionsFromRuns(dir);
  const newCandidates = [];
  for (const suggestion of suggestions) {
    if (existingById.has(suggestion.candidate_id)) continue;
    artifact.candidates.push(suggestion);
    existingById.set(suggestion.candidate_id, suggestion);
    newCandidates.push(suggestion);
  }

  artifact.updated_at = now;
  artifact.summary = buildSummary(artifact.candidates, artifact.decisions || []);
  artifact.action_executed = false;
  artifact.authority_boundary = improvementAuthorityBoundary();
  await writeImprovementCandidates(dir, artifact);
  await writeOwnerInbox(dir, artifact);
  return {
    artifact,
    path: improvementCandidatesRelativePath(),
    created: !existing,
    new_candidates: newCandidates,
  };
}

export async function listImprovements(dir = process.cwd()) {
  const artifact = await readImprovementCandidates(dir);
  return improvementCandidateStatusFromArtifact(artifact);
}

export async function decideImprovement({
  dir = process.cwd(),
  candidate_id,
  decision,
} = {}) {
  if (!candidate_id) throw new Error('improve decide requires a candidate_id');
  if (!DECISIONS.includes(decision)) throw new Error('decision must be accept, reject, or defer');
  const artifact = await readImprovementCandidates(dir);
  if (!artifact) throw new Error('improvement candidates are not initialized');
  const candidate = (artifact.candidates || []).find((entry) => entry.candidate_id === candidate_id);
  if (!candidate) throw new Error(`improvement candidate not found: ${candidate_id}`);

  const decidedAt = new Date().toISOString();
  const decisionId = stableId('improvement_decision', `${candidate_id}:${decision}:${decidedAt}`);
  const decisionRef = `${improvementCandidatesRelativePath()}#decisions/${decisionId}`;
  const payload = {
    schema: 'agoragentic.harness.improvement-decision.v1',
    decision_id: decisionId,
    candidate_id,
    decided_at: decidedAt,
    decision,
    status: STATUS_BY_DECISION[decision],
    decision_ref: decisionRef,
    action_executed: false,
    authority_boundary: improvementAuthorityBoundary(),
  };

  artifact.decisions = [...(artifact.decisions || []), payload];
  candidate.status = payload.status;
  candidate.decision = decision;
  candidate.decided_at = decidedAt;
  candidate.latest_decision_ref = decisionRef;
  candidate.action_executed = false;
  artifact.updated_at = decidedAt;
  artifact.summary = buildSummary(artifact.candidates || [], artifact.decisions || []);
  artifact.action_executed = false;
  artifact.authority_boundary = improvementAuthorityBoundary();
  await writeImprovementCandidates(dir, artifact);
  await writeOwnerInbox(dir, artifact);
  return { decision: payload, artifact, path: improvementCandidatesRelativePath() };
}

export async function improvementCandidateStatus(dir = process.cwd()) {
  return improvementCandidateStatusFromArtifact(await readImprovementCandidates(dir));
}

export async function ownerInboxStatus(dir = process.cwd()) {
  const inbox = await readJsonIfExists(ownerInboxPath(dir));
  if (inbox) {
    return {
      present: true,
      path: ownerInboxRelativePath(),
      ...inbox,
      action_executed: false,
      authority_boundary: improvementAuthorityBoundary(),
    };
  }
  const improvements = await improvementCandidateStatus(dir);
  return {
    present: false,
    path: null,
    schema: OWNER_INBOX_SCHEMA,
    generated_at: null,
    mode: 'local_owner_review_no_execution',
    open_improvement_candidates: improvements.open_candidates,
    action_executed: false,
    authority_boundary: improvementAuthorityBoundary(),
  };
}

export async function readImprovementCandidates(dir = process.cwd()) {
  return readJsonIfExists(improvementCandidatesPath(dir));
}

function improvementCandidateStatusFromArtifact(artifact) {
  if (!artifact) {
    return {
      present: false,
      path: null,
      candidates: [],
      open_candidates: [],
      latest_decision_refs: [],
      summary: buildSummary([], []),
      action_executed: false,
      authority_boundary: improvementAuthorityBoundary(),
    };
  }
  const candidates = artifact.candidates || [];
  const decisions = artifact.decisions || [];
  return {
    present: true,
    path: improvementCandidatesRelativePath(),
    schema: artifact.schema,
    candidates,
    open_candidates: candidates.filter((candidate) => candidate.status === 'open'),
    latest_decision_refs: decisions.map((decision) => decision.decision_ref).filter(Boolean),
    summary: buildSummary(candidates, decisions),
    action_executed: false,
    authority_boundary: improvementAuthorityBoundary(),
  };
}

async function deriveSuggestionsFromRuns(dir) {
  const latest = await latestRunState(dir);
  if (!latest) return [];
  const evidenceBase = await runEvidenceRefs(dir, latest);
  const suggestions = [];

  if (latest.status !== 'passed') {
    suggestions.push(createCandidate({
      run: latest,
      code: 'resolve_blocked_run',
      title: 'Resolve the latest blocked Harness run before owner review',
      risk_class: 'high',
      affected_surface: 'run_ledger',
      suggested_next_action: `Inspect ${latest.path || `.agoragentic/runs/${latest.run_id}`} events and clear blocked run evidence before preview or listing review.`,
      evidence_refs: evidenceBase,
    }));
    return suggestions;
  }

  if (!latest.artifacts?.runtime_probe) {
    suggestions.push(createCandidate({
      run: latest,
      code: 'add_runtime_probe_evidence',
      title: 'Add loopback runtime probe evidence before preview review',
      risk_class: 'medium',
      affected_surface: 'runtime_evidence',
      suggested_next_action: 'Run agoragentic-harness runtime probe --url http://127.0.0.1:<port> --dir . against the local service candidate.',
      evidence_refs: evidenceBase,
    }));
  }

  if (latest.profile === 'seller_listing_readiness') {
    suggestions.push(createCandidate({
      run: latest,
      code: 'request_owner_review_gate',
      title: 'Request maker-checker owner review for listing readiness',
      risk_class: 'medium',
      affected_surface: 'owner_review',
      suggested_next_action: 'Run agoragentic-harness review request --gate listing-readiness --maker <label> --dir . and record a separate checker decision.',
      evidence_refs: evidenceBase,
    }));
  }

  suggestions.push(createCandidate({
    run: latest,
    code: 'catalog_tool_side_effects',
    title: 'Catalog local tool side effects before publication review',
    risk_class: 'low',
    affected_surface: 'tool_policy',
    suggested_next_action: 'Run agoragentic-harness tools manifest init --dir . and review blocked high-authority tools before preview or listing decisions.',
    evidence_refs: evidenceBase,
  }));

  return suggestions;
}

function createCandidate({
  run,
  code,
  title,
  risk_class,
  affected_surface,
  suggested_next_action,
  evidence_refs,
}) {
  const createdAt = new Date().toISOString();
  const candidateId = stableId('improve', `${run.run_id}:${code}`);
  return {
    schema: 'agoragentic.harness.improvement-candidate.v1',
    candidate_id: candidateId,
    source: {
      kind: 'harness_run',
      run_id: run.run_id,
      profile: run.profile || null,
      status: run.status || null,
    },
    created_at: createdAt,
    updated_at: createdAt,
    status: 'open',
    title: sanitizeForPublicEvidence(title, { maxStringLength: 160 }),
    evidence_refs,
    risk_class,
    affected_surface,
    suggested_next_action: sanitizeForPublicEvidence(suggested_next_action, { maxStringLength: 240 }),
    decision: null,
    latest_decision_ref: null,
    action_executed: false,
    authority_boundary: improvementAuthorityBoundary(),
  };
}

async function runEvidenceRefs(dir, run) {
  const refs = [
    ['run_state', `.agoragentic/runs/${run.run_id}/state.json`],
    ['run_events', `.agoragentic/runs/${run.run_id}/events.jsonl`],
    ['run_summary', `.agoragentic/runs/${run.run_id}/summary.md`],
    ['local_proof', run.artifacts?.local_proof || `.agoragentic/runs/${run.run_id}/local-proof.json`],
    ['local_receipt', run.artifacts?.local_receipt || `.agoragentic/runs/${run.run_id}/local-receipt.json`],
    ['agent_os_harness', run.artifacts?.agent_os_harness || `.agoragentic/runs/${run.run_id}/agent-os-harness.json`],
  ];
  if (run.artifacts?.runtime_probe) refs.push(['runtime_probe', run.artifacts.runtime_probe]);
  const out = [];
  for (const [id, ref] of refs) {
    out.push(await evidenceRef(dir, id, ref));
  }
  return out;
}

async function evidenceRef(dir, id, ref) {
  const relPath = String(ref || '').replace(/\\/g, '/');
  const filePath = path.isAbsolute(relPath) ? relPath : path.join(path.resolve(dir), relPath);
  let text = null;
  try {
    text = await fs.readFile(filePath, 'utf8');
  } catch {
    text = null;
  }
  return {
    id,
    ref: relPath,
    present: text !== null,
    hash: text === null ? null : stableHash(text),
    bytes: text === null ? 0 : Buffer.byteLength(text),
    raw_content_inlined: false,
  };
}

async function writeImprovementCandidates(dir, artifact) {
  await fs.mkdir(harnessDir(dir), { recursive: true });
  await fs.writeFile(improvementCandidatesPath(dir), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
}

async function writeOwnerInbox(dir, artifact) {
  const status = improvementCandidateStatusFromArtifact(artifact);
  const payload = {
    schema: OWNER_INBOX_SCHEMA,
    generated_at: new Date().toISOString(),
    mode: 'local_owner_review_no_execution',
    improvement_candidates_path: improvementCandidatesRelativePath(),
    open_improvement_candidates: status.open_candidates.map((candidate) => ({
      candidate_id: candidate.candidate_id,
      title: candidate.title,
      risk_class: candidate.risk_class,
      affected_surface: candidate.affected_surface,
      suggested_next_action: candidate.suggested_next_action,
      action_executed: false,
    })),
    action_executed: false,
    authority_boundary: improvementAuthorityBoundary(),
  };
  await fs.mkdir(harnessDir(dir), { recursive: true });
  await fs.writeFile(ownerInboxPath(dir), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function buildSummary(candidates, decisions) {
  return {
    candidate_count: candidates.length,
    open_candidate_count: candidates.filter((entry) => entry.status === 'open').length,
    accepted_count: candidates.filter((entry) => entry.status === 'accepted').length,
    rejected_count: candidates.filter((entry) => entry.status === 'rejected').length,
    deferred_count: candidates.filter((entry) => entry.status === 'deferred').length,
    decision_count: decisions.length,
    latest_decision_ref: decisions.length ? decisions[decisions.length - 1].decision_ref : null,
    action_executed: false,
  };
}

function improvementCandidatesPath(dir) {
  return path.join(harnessDir(dir), 'improvement-candidates.json');
}

function improvementCandidatesRelativePath() {
  return '.agoragentic/improvement-candidates.json';
}

function ownerInboxPath(dir) {
  return path.join(harnessDir(dir), 'owner-inbox.json');
}

function ownerInboxRelativePath() {
  return '.agoragentic/owner-inbox.json';
}

function improvementAuthorityBoundary() {
  return authorityBoundary({
    autonomous_self_modification: false,
    source_file_mutation: false,
    git_commit: false,
    pull_request_creation: false,
    hosted_memory_write: false,
    provider_dispatch: false,
    execute_invoke_change: false,
  });
}
