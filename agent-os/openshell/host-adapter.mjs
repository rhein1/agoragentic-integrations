import { createHash } from 'node:crypto';
import { validateOpenShellPlan, summarizeOpenShellObservation } from './scaffold.mjs';

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function fields(value, required) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== required.length
    || required.some((key) => !Object.hasOwn(value, key))) fail('invalid_journal_fields');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

const EVENT_FIELDS = Object.freeze({
  create_requested: [], create_unknown: [], create_rejected: [],
  created: ['sandboxId'], ready: ['sandboxId'],
  config_observed: ['sandboxId', 'image', 'policyDigest'],
  exec_started: ['sandboxId'], exec_unknown: ['sandboxId'],
  exec_terminal: ['sandboxId', 'exitCode'],
  cancelled: [], timed_out: [], revoked: [],
  delete_requested: ['sandboxId'], deletion_observed: ['sandboxId', 'outcome'],
});

/**
 * Replay a bounded, untrusted observation journal. No gateway, authority,
 * callback or worker is involved. Sequence validation helps a future host
 * reconcile failures; it does not authenticate the observations or the plan.
 * JSON text is intentional: this entry point never evaluates object accessors.
 */
export function reconcileOpenShellLifecycle(planInput, journalText) {
  const plan = validateOpenShellPlan(planInput);
  if (typeof journalText !== 'string' || Buffer.byteLength(journalText, 'utf8') > 65536) fail('bounded_journal_json_required');
  let journal;
  try { journal = JSON.parse(journalText); } catch { fail('invalid_journal_json'); }
  fields(journal, ['schema', 'planDigest', 'events']);
  if (journal.schema !== 'agoragentic.openshell.lifecycle-journal.v1') fail('unsupported_journal_schema');
  if (journal.planDigest !== plan.planDigest) fail('journal_plan_mismatch');
  if (!Array.isArray(journal.events) || journal.events.length > 128) fail('invalid_journal_events');

  let creation = 'not_requested';
  let sandboxId = null;
  let ready = false;
  let config = 'not_observed';
  let execution = 'not_started';
  let terminal = null;
  let cleanup = 'not_requested';
  let deletion = null;
  const interruptions = [];
  const requireState = (condition) => { if (!condition) fail('invalid_lifecycle_sequence'); };

  for (const [index, event] of journal.events.entries()) {
    if (!event || !Object.hasOwn(EVENT_FIELDS, event.type)) fail('unsupported_lifecycle_event');
    fields(event, ['seq', 'type', ...EVENT_FIELDS[event.type]]);
    if (event.seq !== index + 1) fail('non_contiguous_journal');
    requireState(cleanup !== 'reported_completed' && creation !== 'reported_rejected');
    if (Object.hasOwn(event, 'sandboxId')) {
      if (typeof event.sandboxId !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(event.sandboxId)) fail('invalid_sandbox_id');
      if (sandboxId !== null && event.sandboxId !== sandboxId) fail('sandbox_identity_mismatch');
    }
    const uninterrupted = interruptions.length === 0 && cleanup === 'not_requested';
    switch (event.type) {
      case 'create_requested':
        requireState(creation === 'not_requested');
        creation = 'pending';
        break;
      case 'create_unknown':
        requireState(creation === 'pending');
        creation = 'unknown';
        interruptions.push('create_unknown');
        break;
      case 'create_rejected':
        requireState(['pending', 'unknown'].includes(creation));
        creation = 'reported_rejected';
        break;
      case 'created':
        // After ambiguous create or cancellation, a late ID is retained for
        // cleanup. A second create is never inferred or authorized.
        requireState(['pending', 'unknown'].includes(creation));
        sandboxId = event.sandboxId;
        creation = 'reported_created';
        break;
      case 'ready':
        requireState(sandboxId !== null && !ready && uninterrupted);
        ready = true;
        break;
      case 'config_observed':
        requireState(ready && config === 'not_observed' && uninterrupted);
        if (typeof event.image !== 'string' || typeof event.policyDigest !== 'string') fail('invalid_config_observation');
        config = event.image === plan.request.image && event.policyDigest === plan.policyDigest
          ? 'reported_local_projection_match' : 'reported_mismatch';
        if (config === 'reported_mismatch') interruptions.push('config_mismatch');
        break;
      case 'exec_started':
        requireState(ready && config === 'reported_local_projection_match' && execution === 'not_started' && uninterrupted);
        execution = 'running';
        break;
      case 'exec_unknown':
        requireState(execution === 'running');
        execution = 'unknown';
        interruptions.push('exec_unknown');
        break;
      case 'exec_terminal':
        requireState(['running', 'unknown'].includes(execution));
        terminal = summarizeOpenShellObservation(plan, sandboxId, { kind: 'exec', sandboxId: event.sandboxId, exitCode: event.exitCode });
        execution = terminal.reportedStatus;
        break;
      case 'cancelled':
      case 'timed_out':
      case 'revoked':
        requireState(creation !== 'not_requested' && !interruptions.includes(event.type));
        interruptions.push(event.type);
        // RPC cancellation/deadline/revocation alone cannot prove termination.
        if (execution === 'running') execution = 'unknown';
        break;
      case 'delete_requested':
        requireState(sandboxId !== null && cleanup === 'not_requested');
        cleanup = 'requested';
        if (execution === 'running') execution = 'unknown';
        break;
      case 'deletion_observed':
        requireState(cleanup !== 'not_requested');
        deletion = summarizeOpenShellObservation(plan, sandboxId, { kind: 'delete', sandboxId: event.sandboxId, outcome: event.outcome });
        cleanup = deletion.reportedStatus;
        break;
      default: fail('unsupported_lifecycle_event');
    }
  }

  const cleanupOutstanding = sandboxId !== null && cleanup !== 'reported_completed';
  const identityOutstanding = ['pending', 'unknown'].includes(creation);
  return freeze({
    schema: 'agoragentic.openshell.lifecycle-reconciliation.v1',
    runId: plan.request.runId, workspace: plan.request.workspace, planDigest: plan.planDigest,
    journalDigest: `sha256:${createHash('sha256').update(canonical(journal)).digest('hex')}`,
    eventCount: journal.events.length, sandboxId, creation, ready, config, execution,
    terminal, cleanup, deletion, interruptions,
    reconciliationRequired: identityOutstanding || cleanupOutstanding,
    terminationVerified: false, cleanupVerified: false,
    evidenceClass: 'caller_reported_unverified',
    executionAuthority: false, repeatCreateAllowed: false, repeatExecAllowed: false,
    providerCalls: false, runtimeContainmentVerified: false, liveTrafficProtected: false,
  });
}

export function openShellHostReadiness() {
  return freeze({
    status: 'offline_lifecycle_reconciliation', activationSupported: false,
    providerCalls: false, processStarted: false, networkUsed: false, credentialsUsed: false,
    blockers: ['real_agent_os_authority_boundary_not_bound', 'qualified_gateway_and_image_missing',
      'live_containment_not_tested', 'owner_activation_not_approved'],
  });
}

export async function invokeOpenShell() { fail('openshell_live_adapter_not_implemented'); }
