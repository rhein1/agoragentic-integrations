import { promises as fs } from 'node:fs';
import path from 'node:path';
import { authorityBoundary } from './events.mjs';
import { listApprovals } from './approvals.mjs';
import { contextStatus } from './context-import.mjs';
import { reviewGateStatus } from './review-gates.mjs';
import { getHarnessScheduleStatus } from './schedule.mjs';
import { harnessDir, latestRunState, listRunStates, readJsonIfExists } from './state.mjs';
import { getWorktreeSessionStatus } from './worktree-session.mjs';

export const STATUS_SCHEMA = 'agoragentic.harness.status.v1';

export async function buildHarnessStatus({ dir = process.cwd() } = {}) {
  const root = harnessDir(dir);
  const runs = await listRunStates(dir);
  const latest = await latestRunState(dir);
  const approvals = await listApprovals(dir);
  const pendingApprovals = approvals.filter((entry) => entry.status === 'pending');
  const runtimeProbes = await listArtifacts(path.join(root, 'runtime-probes'));
  const context = await contextStatus(dir);
  const reviewGates = await reviewGateStatus(dir);
  const schedule = await getHarnessScheduleStatus({ dir });
  const worktree = await getWorktreeSessionStatus({ dir });
  const guardReceipts = await listArtifacts(path.join(root, 'guard-receipts'));
  const latestProof = await readJsonIfExists(path.join(root, 'local-proof.json'));
  const latestReceipt = await readJsonIfExists(path.join(root, 'local-receipt.json'));
  const latestExport = await readJsonIfExists(path.join(root, 'agent-os-harness.json'));
  const listingReadiness = await readJsonIfExists(path.join(root, 'listing-readiness.json'));
  const blockers = [];
  if (latest?.status === 'blocked' || latest?.status === 'failed') blockers.push({ code: 'latest_run_not_passed', run_id: latest.run_id, status: latest.status });
  if (pendingApprovals.length) blockers.push({ code: 'pending_approvals', count: pendingApprovals.length });
  if (listingReadiness?.status === 'blocked') blockers.push({ code: 'listing_readiness_blocked' });
  if (!latestProof) blockers.push({ code: 'local_proof_missing' });
  if (!latestReceipt) blockers.push({ code: 'local_receipt_missing' });

  return {
    schema: STATUS_SCHEMA,
    generated_at: new Date().toISOString(),
    mode: 'local_no_spend',
    latest_run: latest ? summarizeRun(latest) : null,
    runs: runs.slice(0, 20).map(summarizeRun),
    latest_proof: summarizeArtifact(latestProof, 'proof_id', 'status'),
    latest_receipt: summarizeArtifact(latestReceipt, 'receipt_id', 'status'),
    agent_os_export: latestExport ? {
      schema: latestExport.schema,
      generated_at: latestExport.generated_at || null,
      preview_endpoint: latestExport.agent_os_export?.preview_endpoint || null,
      public_boundary: latestExport.public_boundary || null,
    } : null,
    listing_readiness: listingReadiness ? {
      schema: listingReadiness.schema,
      status: listingReadiness.status || listingReadiness.recommendation || null,
    } : null,
    pending_approvals: pendingApprovals,
    guard_receipts: guardReceipts,
    runtime_probes: runtimeProbes,
    context_imports: context.imports,
    review_gates: reviewGates,
    schedule_intent: {
      present: schedule.intent_present,
      path: schedule.schedule_path,
      schedules: schedule.schedules,
      execution_policy: schedule.execution_policy,
    },
    schedule_due: {
      checked_at: schedule.checked_at,
      due_count: schedule.due_count,
      due_schedules: schedule.due_schedules,
      due_states: schedule.due_states,
    },
    worktree_session: {
      present: worktree.present,
      active: worktree.active,
      path: worktree.session_path,
      session: worktree.session,
      latest_harness_run_ref: worktree.latest_harness_run_ref,
      authority_boundary: worktree.authority_boundary,
    },
    blockers,
    next_actions: nextActions({ latest, pendingApprovals, latestProof, latestReceipt, latestExport, listingReadiness, schedule, worktree, reviewGates }),
    authority_boundary: authorityBoundary(),
  };
}

export async function writeHarnessStatus({ dir = process.cwd(), status = null } = {}) {
  const payload = status || await buildHarnessStatus({ dir });
  const root = harnessDir(dir);
  await fs.mkdir(root, { recursive: true });
  const jsonPath = path.join(root, 'status.json');
  const mdPath = path.join(root, 'status.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, renderStatusMarkdown(payload), 'utf8');
  return { json_path: '.agoragentic/status.json', md_path: '.agoragentic/status.md', status: payload };
}

function summarizeRun(run) {
  return {
    run_id: run.run_id,
    created_at: run.created_at,
    completed_at: run.completed_at,
    status: run.status,
    profile: run.profile,
    task: run.task,
    event_count: run.event_count,
    approval_count: run.approval_count,
    guard_decision_count: run.guard_decision_count,
    blocked_actions: run.blocked_actions || [],
    path: `.agoragentic/runs/${run.run_id}`,
  };
}

function summarizeArtifact(payload, idKey, statusKey) {
  if (!payload) return null;
  return {
    schema: payload.schema,
    id: payload[idKey] || null,
    status: payload[statusKey] || null,
    created_at: payload.created_at || null,
  };
}

async function listArtifacts(dir) {
  let files = [];
  try {
    files = (await fs.readdir(dir)).filter((file) => file.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const records = [];
  for (const file of files.slice(-20)) {
    const payload = await readJsonIfExists(path.join(dir, file));
    records.push({
      path: path.relative(path.dirname(path.dirname(dir)), path.join(dir, file)).replace(/\\/g, '/'),
      schema: payload?.schema || null,
      id: payload?.probe_id || payload?.receipt_id || payload?.approval_id || payload?.source || file.replace(/\.json$/, ''),
      status: payload?.status || null,
      created_at: payload?.created_at || payload?.imported_at || payload?.decided_at || null,
    });
  }
  return records;
}

function nextActions({ latest, pendingApprovals, latestProof, latestReceipt, latestExport, listingReadiness, schedule, worktree, reviewGates }) {
  if (pendingApprovals.length) return ['Review pending local approval artifacts.'];
  if (reviewGates?.required_checker_decisions?.length) return ['Record required checker decision for open local review gate.'];
  if (schedule?.due_schedules?.length) return schedule.due_schedules.map((entry) => `Run ${entry.manual_command}`);
  if (worktree?.active && worktree.session?.owner_review_state === 'pending_owner_review') return ['Review attached worktree session refs before public handoff.'];
  if (!latest) return ['Run agoragentic-harness run --dir .'];
  if (latest.status !== 'passed') return ['Inspect the latest run summary and fix blockers.'];
  if (!latestProof || !latestReceipt) return ['Run agoragentic-harness proof --record --dir .'];
  if (!latestExport) return ['Run agoragentic-harness export --to agent-os --dir .'];
  if (!listingReadiness) return ['Run agoragentic-harness listing check --dir .'];
  if (listingReadiness.status === 'blocked') return ['Resolve listing readiness blockers before any Seller OS handoff.'];
  return ['Owner may review the local packet for optional Agent OS preview.'];
}

function renderStatusMarkdown(status) {
  return `# Harness Core Status

- Generated: ${status.generated_at}
- Mode: ${status.mode}
- Latest run: ${status.latest_run ? `${status.latest_run.run_id} (${status.latest_run.status})` : 'none'}
- Pending approvals: ${status.pending_approvals.length}
- Runtime probes: ${status.runtime_probes.length}
- Context imports: ${status.context_imports.length}
- Open review requests: ${status.review_gates.open_requests.length}
- Schedule intent: ${status.schedule_intent.present ? 'present' : 'none'}
- Due schedules: ${status.schedule_due.due_count}
- Worktree session: ${status.worktree_session.present ? status.worktree_session.session?.worktree?.branch || 'present' : 'none'}

## Blockers

${status.blockers.map((entry) => `- ${entry.code}`).join('\n') || '- None'}

## Next Actions

${status.next_actions.map((entry) => `- ${entry}`).join('\n')}

## Boundary

Status is local no-spend evidence only. It does not spend, settle x402, publish listings, provision hosted runtime, dispatch providers, mutate trust/ranking, export private ECF internals, bypass owner approval, or change public execute/invoke behavior.
`;
}
