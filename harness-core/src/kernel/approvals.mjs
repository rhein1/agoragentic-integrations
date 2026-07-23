import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary, sanitizeForPublicEvidence, stableId } from './events.mjs';
import { harnessDir, readJsonIfExists } from './state.mjs';

export const APPROVAL_SCHEMA = 'agoragentic.harness.approval-request.v1';

export async function createApprovalRequest({
  dir = process.cwd(),
  run_id,
  requested_action = {},
  risk_class = 'review_required',
  reason = 'owner approval required',
  required_approvals = [],
  source_event_id = null,
  guard_decision_id = null,
} = {}) {
  const createdAt = new Date().toISOString();
  const seed = `${run_id}:${risk_class}:${reason}:${JSON.stringify(requested_action)}:${createdAt}`;
  const approvalId = stableId('approval', seed);
  const request = {
    schema: APPROVAL_SCHEMA,
    approval_id: approvalId,
    run_id: run_id || null,
    created_at: createdAt,
    status: 'pending',
    requested_action: sanitizeForPublicEvidence(requested_action),
    risk_class,
    reason: sanitizeForPublicEvidence(reason, { maxStringLength: 240 }),
    required_approvals: [...required_approvals],
    default_decision: 'reject',
    decision_options: ['approve', 'reject', 'edit'],
    authority_boundary: authorityBoundary(),
    source_event_id,
    ...(guard_decision_id ? { guard_decision_id } : {}),
  };

  const root = approvalsDir(dir);
  await fs.mkdir(root, { recursive: true });
  const filePath = approvalPath(dir, approvalId);
  await fs.writeFile(filePath, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
  await fs.appendFile(path.join(root, 'index.jsonl'), `${JSON.stringify({
    approval_id: approvalId,
    run_id: request.run_id,
    status: request.status,
    risk_class: request.risk_class,
    created_at: request.created_at,
    approval_path: relativePath(dir, filePath),
  })}\n`, 'utf8');
  return request;
}

export async function listApprovals(dir = process.cwd()) {
  const indexPath = path.join(approvalsDir(dir), 'index.jsonl');
  let lines = [];
  try {
    lines = (await fs.readFile(indexPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
  const latestById = new Map();
  for (const line of lines) {
    const row = JSON.parse(line);
    const previous = latestById.get(row.approval_id);
    if (!previous || compareApprovalRows(row, previous) > 0) {
      latestById.set(row.approval_id, {
        ...(previous || {}),
        ...row,
      });
    }
  }
  return [...latestById.values()].sort((a, b) => compareApprovalRows(b, a));
}

export async function showApproval(dir, approvalId) {
  const request = await readJsonIfExists(approvalPath(dir, approvalId));
  if (!request) return null;
  const decision = await readJsonIfExists(decisionPath(dir, approvalId));
  return { request, decision };
}

export async function decideApproval({
  dir = process.cwd(),
  approval_id,
  decision,
  note = '',
} = {}) {
  if (!['approve', 'reject', 'edit'].includes(decision)) {
    throw new Error('decision must be approve, reject, or edit');
  }
  const existing = await readJsonIfExists(approvalPath(dir, approval_id));
  if (!existing) throw new Error(`approval not found: ${approval_id}`);
  const status = decision === 'approve' ? 'approved' : decision === 'edit' ? 'edited' : 'rejected';
  const payload = {
    schema: 'agoragentic.harness.approval-decision.v1',
    approval_id,
    run_id: existing.run_id || null,
    decided_at: new Date().toISOString(),
    decision,
    status,
    note: sanitizeForPublicEvidence(note, { maxStringLength: 240 }),
    action_executed: false,
    authority_boundary: authorityBoundary(),
  };
  await fs.mkdir(approvalsDir(dir), { recursive: true });
  await fs.writeFile(decisionPath(dir, approval_id), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const updated = { ...existing, status };
  await fs.writeFile(approvalPath(dir, approval_id), `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  await fs.appendFile(path.join(approvalsDir(dir), 'index.jsonl'), `${JSON.stringify({
    approval_id,
    run_id: existing.run_id || null,
    status,
    risk_class: existing.risk_class,
    decided_at: payload.decided_at,
    decision_path: relativePath(dir, decisionPath(dir, approval_id)),
    action_executed: false,
  })}\n`, 'utf8');
  return payload;
}

export function approvalsDir(dir = process.cwd()) {
  return path.join(harnessDir(dir), 'approvals');
}

function approvalPath(dir, approvalId) {
  return path.join(approvalsDir(dir), `${approvalId}.json`);
}

function decisionPath(dir, approvalId) {
  return path.join(approvalsDir(dir), `${approvalId}.decision.json`);
}

function relativePath(dir, filePath) {
  return path.relative(path.resolve(dir), filePath).replace(/\\/g, '/');
}

function approvalRowTime(row = {}) {
  return String(row.decided_at || row.created_at || '');
}

function compareApprovalRows(a, b) {
  return approvalRowTime(a).localeCompare(approvalRowTime(b));
}
