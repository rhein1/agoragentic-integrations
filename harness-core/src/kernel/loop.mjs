import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildAgentOsExport,
  checkListingReadiness,
  loadProject,
  writeJsonArtifact,
} from '../index.mjs';
import { authorityBoundary, sanitizeForPublicEvidence } from './events.mjs';
import { executeHarnessRun } from './run.mjs';
import { harnessDir, readRunEvents, readRunState } from './state.mjs';
import { buildHarnessStatus, writeHarnessStatus } from './status.mjs';

export const OWNER_INBOX_SCHEMA = 'agoragentic.harness.owner-inbox.v1';

const SELLER_LISTING_LOOP_ID = 'seller-listing-readiness';
const SELLER_LISTING_PROFILE_ID = 'seller_listing_readiness';
const DEFAULT_SELLER_LISTING_TASK = 'verify this local service can become an Agent OS listing';

const NO_AUTHORITY_STATEMENT = [
  'This owner inbox is a local review artifact only.',
  'It grants no wallet spend or wallet mutation, x402 settlement or route activation, marketplace publication, hosted provisioning, provider dispatch, trust or ranking mutation, private ECF export, public execute/invoke behavior change, owner approval bypass, process-control, shell, service start, SSH, or tunnel authority.',
].join(' ');

export async function executeHarnessLoop({
  dir = process.cwd(),
  loop = SELLER_LISTING_LOOP_ID,
  once = true,
  write_inbox = true,
  task = DEFAULT_SELLER_LISTING_TASK,
} = {}) {
  if (loop !== SELLER_LISTING_LOOP_ID) {
    throw new Error(`unsupported harness loop: ${loop}`);
  }
  if (once !== true) {
    throw new Error('Harness Core loops currently support --once execution only');
  }

  const run = await executeHarnessRun({
    dir,
    profile: SELLER_LISTING_PROFILE_ID,
    task: task || DEFAULT_SELLER_LISTING_TASK,
  });

  let exportPath = null;
  let readinessPath = null;
  let readiness = null;

  if (run.ok) {
    const project = await loadProject(dir);
    const packet = buildAgentOsExport(project);
    exportPath = await writeJsonArtifact(dir, 'agent-os-harness.json', packet);
    readiness = await checkListingReadiness(project, dir);
    readinessPath = await writeJsonArtifact(dir, 'listing-readiness.json', readiness);
  }

  const statusWrite = await writeHarnessStatus({ dir, status: await buildHarnessStatus({ dir }) });
  const runState = await readRunState(dir, run.run_id);
  const events = await readRunEvents(dir, run.run_id);
  const inbox = buildOwnerInbox({
    dir,
    run,
    runState,
    eventCount: events.length,
    readiness,
    readinessPath,
    exportPath,
    status: statusWrite.status,
  });

  const inboxWrite = write_inbox
    ? await writeOwnerInbox({ dir, inbox })
    : { json_path: null, md_path: null };

  const ok = run.ok && (!readiness || readiness.status !== 'blocked');
  return {
    ok,
    status: ok ? 'proposal_ready' : run.status || 'blocked',
    loop: SELLER_LISTING_LOOP_ID,
    run_id: run.run_id,
    run_path: run.run_path,
    owner_inbox_path: inboxWrite.json_path,
    owner_inbox_md_path: inboxWrite.md_path,
    status_path: statusWrite.json_path,
    export_path: exportPath ? relativePath(dir, exportPath) : null,
    readiness_path: readinessPath ? relativePath(dir, readinessPath) : null,
    inbox,
  };
}

export function buildOwnerInbox({
  dir = process.cwd(),
  run,
  runState,
  eventCount,
  readiness,
  readinessPath,
  exportPath,
  status,
} = {}) {
  const runPath = run?.run_path || (run?.run_id ? `.agoragentic/runs/${run.run_id}` : null);
  const latestRun = status?.latest_run || summarizeRun(run, runState, eventCount);
  const pendingApprovals = sanitizeForPublicEvidence(status?.pending_approvals || []);
  const scheduleIntent = status?.schedule_intent || {
    present: false,
    path: null,
    schedules: [],
    execution_policy: null,
  };
  const scheduleDue = status?.schedule_due || {
    checked_at: null,
    due_count: 0,
    due_schedules: [],
    due_states: [],
  };
  const reviewGatesRaw = status?.review_gates;
  const reviewGates = reviewGatesRaw ? {
    ...reviewGatesRaw,
    open_review_requests: reviewGatesRaw.open_requests || [],
  } : {
    present: false,
    path: null,
    gates: [],
    open_review_requests: [],
    latest_decision_refs: [],
    blocked_actions: [],
    required_checker_decisions: [],
  };
  const worktreeSession = status?.worktree_session || {
    present: false,
    active: false,
    path: null,
    session: null,
    latest_harness_run_ref: null,
  };
  const blockers = dedupeByCode([
    ...(status?.blockers || []),
    ...(readiness?.blockers || []).map((entry) => ({
      code: entry.code,
      message: entry.message,
    })),
  ]);
  const nextOwnerActions = dedupeStrings([
    ...(status?.next_actions || []),
    ...(readiness?.next_actions || []),
  ]);

  return {
    schema: OWNER_INBOX_SCHEMA,
    generated_at: new Date().toISOString(),
    mode: 'local_no_spend',
    loop: {
      id: SELLER_LISTING_LOOP_ID,
      profile: SELLER_LISTING_PROFILE_ID,
      once: true,
      scheduling_enabled: false,
      write_inbox: true,
    },
    latest_run: latestRun,
    event_count: eventCount,
    refs: {
      run: runPath,
      state: runPath ? `${runPath}/state.json` : null,
      events: runPath ? `${runPath}/events.jsonl` : null,
      proof: runPath ? `${runPath}/local-proof.json` : null,
      receipt: runPath ? `${runPath}/local-receipt.json` : null,
      agent_os_export: exportPath ? relativePath(dir, exportPath) : '.agoragentic/agent-os-harness.json',
      listing_readiness: readinessPath ? relativePath(dir, readinessPath) : '.agoragentic/listing-readiness.json',
      review_gates: reviewGates.path || null,
      schedule: scheduleIntent.path || null,
      worktree_session: worktreeSession.path || null,
      status: '.agoragentic/status.json',
      status_markdown: '.agoragentic/status.md',
    },
    proof_ref: runPath ? `${runPath}/local-proof.json` : null,
    receipt_ref: runPath ? `${runPath}/local-receipt.json` : null,
    agent_os_export_ref: exportPath ? relativePath(dir, exportPath) : '.agoragentic/agent-os-harness.json',
    listing_readiness: readiness ? {
      schema: readiness.schema,
      status: readiness.status,
      proposal_only: true,
      owner_review_required: readiness.checks?.owner_review_required === true,
      blocker_count: readiness.blockers?.length || 0,
    } : null,
    listing_readiness_status: readiness?.status || status?.listing_readiness?.status || null,
    review_gates: sanitizeForPublicEvidence({
      present: reviewGates.present,
      path: reviewGates.path,
      open_review_requests: reviewGates.open_review_requests || [],
      required_checker_decisions: reviewGates.required_checker_decisions || [],
      blocked_actions: reviewGates.blocked_actions || [],
      latest_decision_refs: reviewGates.latest_decision_refs || [],
    }),
    open_review_requests: sanitizeForPublicEvidence(reviewGates.open_review_requests || []),
    required_checker_decisions: sanitizeForPublicEvidence(reviewGates.required_checker_decisions || []),
    blocked_review_actions: sanitizeForPublicEvidence(reviewGates.blocked_actions || []),
    latest_review_decision_refs: sanitizeForPublicEvidence(reviewGates.latest_decision_refs || []),
    schedule: sanitizeForPublicEvidence({
      intent_present: scheduleIntent.present,
      path: scheduleIntent.path,
      schedules: scheduleIntent.schedules || [],
      execution_policy: scheduleIntent.execution_policy,
      due: scheduleDue,
    }),
    due_schedules: sanitizeForPublicEvidence(scheduleDue.due_schedules || []),
    worktree_session: sanitizeForPublicEvidence({
      present: worktreeSession.present,
      active: worktreeSession.active,
      path: worktreeSession.path,
      session: worktreeSession.session,
      latest_harness_run_ref: worktreeSession.latest_harness_run_ref,
    }),
    blockers: sanitizeForPublicEvidence(blockers),
    pending_approvals: pendingApprovals,
    next_owner_actions: sanitizeForPublicEvidence(nextOwnerActions),
    artifact_policy: {
      refs_only: true,
      raw_payloads_included: false,
      raw_prompts_included: false,
      raw_tool_outputs_included: false,
      private_ecf_payloads_included: false,
      secrets_included: false,
    },
    proposal_boundary: {
      listing_readiness_only: true,
      marketplace_publication_triggered: false,
      x402_route_created: false,
      hosted_provisioning_triggered: false,
      trust_or_ranking_mutated: false,
      public_execute_or_invoke_changed: false,
    },
    authority_boundary: authorityBoundary({
      service_start: false,
      ssh: false,
      tunnel: false,
    }),
    no_authority_granted: {
      statement: NO_AUTHORITY_STATEMENT,
      wallet_spend: false,
      wallet_mutation: false,
      x402_settlement: false,
      x402_route_activation: false,
      marketplace_publication: false,
      hosted_provisioning: false,
      provider_dispatch: false,
      trust_mutation: false,
      ranking_mutation: false,
      private_ecf_export: false,
      public_execute_invoke_change: false,
      owner_approval_bypass: false,
      process_control: false,
      shell: false,
      service_start: false,
      ssh: false,
      tunnel: false,
    },
  };
}

export async function writeOwnerInbox({ dir = process.cwd(), inbox } = {}) {
  const root = harnessDir(dir);
  await fs.mkdir(root, { recursive: true });
  const jsonPath = path.join(root, 'owner-inbox.json');
  const mdPath = path.join(root, 'owner-inbox.md');
  await fs.writeFile(jsonPath, `${JSON.stringify(inbox, null, 2)}\n`, 'utf8');
  await fs.writeFile(mdPath, renderOwnerInboxMarkdown(inbox), 'utf8');
  return {
    json_path: '.agoragentic/owner-inbox.json',
    md_path: '.agoragentic/owner-inbox.md',
  };
}

function summarizeRun(run, runState, eventCount) {
  return {
    run_id: runState?.run_id || run?.run_id || null,
    path: run?.run_path || (runState?.run_id ? `.agoragentic/runs/${runState.run_id}` : null),
    status: runState?.status || run?.status || null,
    profile: runState?.profile || SELLER_LISTING_PROFILE_ID,
    task: runState?.task || DEFAULT_SELLER_LISTING_TASK,
    event_count: eventCount,
    approval_count: runState?.approval_count || 0,
    guard_decision_count: runState?.guard_decision_count || 0,
  };
}

function renderOwnerInboxMarkdown(inbox) {
  return `# Harness Owner Inbox

- Generated: ${inbox.generated_at}
- Mode: ${inbox.mode}
- Loop: ${inbox.loop.id}
- Latest run: ${inbox.latest_run?.run_id || 'none'} (${inbox.latest_run?.status || 'unknown'})
- Events: ${inbox.event_count}
- Listing readiness: ${inbox.listing_readiness_status || 'unknown'}
- Open review requests: ${inbox.open_review_requests.length}
- Schedule intent: ${inbox.schedule.intent_present ? 'present' : 'none'}
- Due schedules: ${inbox.schedule.due?.due_count || 0}
- Worktree session: ${inbox.worktree_session.present ? inbox.worktree_session.session?.worktree?.branch || 'present' : 'none'}

## Refs

- Run: ${inbox.refs.run || 'none'}
- Proof: ${inbox.proof_ref || 'none'}
- Receipt: ${inbox.receipt_ref || 'none'}
- Agent OS export: ${inbox.agent_os_export_ref || 'none'}
- Listing readiness: ${inbox.refs.listing_readiness || 'none'}
- Review gates: ${inbox.refs.review_gates || 'none'}
- Schedule: ${inbox.refs.schedule || 'none'}
- Worktree session: ${inbox.refs.worktree_session || 'none'}

## Blockers

${inbox.blockers.map((entry) => `- ${entry.code}${entry.message ? `: ${entry.message}` : ''}`).join('\n') || '- None'}

## Next Owner Actions

${inbox.next_owner_actions.map((entry) => `- ${entry}`).join('\n') || '- None'}

## Boundary

${inbox.no_authority_granted.statement}
`;
}

function dedupeByCode(items) {
  const byKey = new Map();
  for (const item of items) {
    const key = item?.code || JSON.stringify(item);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

function dedupeStrings(items) {
  return [...new Set(items.filter(Boolean).map(String))];
}

function relativePath(dir, filePath) {
  return path.relative(path.resolve(dir), filePath).replace(/\\/g, '/');
}
