import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  createApprovalRequest,
  createLocalReceipt,
  parseSimpleYaml,
  showApproval,
} from 'agoragentic-harness-core';
import {
  authorityBoundary,
  createHarnessEvent,
  sanitizeText,
  stableHash,
  stableId,
} from 'agoragentic-harness-core/kernel/events';

import { evaluateOpenCodeAction, mapOpenCodeToolCall } from './mapping.mjs';

export const OPENCODE_LEDGER_SCHEMA = 'agoragentic.harness.opencode-ledger.v1';
export const OPENCODE_APPROVAL_REF_SCHEMA = 'agoragentic.harness.opencode-approval-ref.v1';
export const OPENCODE_HANDOFF_SCHEMA = 'agoragentic.harness.opencode-memory-handoff.v1';

const PLUGIN_NAME = '@agoragentic/opencode';
const APPROVAL_ID_PATTERN = /^approval_[a-f0-9]{12}$/;
const MAX_REASON_CODES = 16;

export class OpenCodeGovernanceBlock extends Error {
  constructor(message, { code, decision, approval_id = null, receipt_ref = null } = {}) {
    super(message);
    this.name = 'OpenCodeGovernanceBlock';
    this.code = code || 'governance_blocked';
    this.decision = decision || 'deny';
    this.approval_id = approval_id;
    this.receipt_ref = receipt_ref;
  }
}

export function createOpenCodeHooks({
  directory = process.cwd(),
  options = {},
  policy,
  policy_file,
  internals = {},
} = {}) {
  const root = path.resolve(String(directory || process.cwd()));
  const configuredPolicy = policy ?? options.policy;
  const configuredPolicyFile = policy_file ?? options.policy_file ?? 'policy.yaml';
  const memoryHandoff = options.memory_handoff === 'local_ref';
  const nowMs = typeof internals.now_ms === 'function' ? internals.now_ms : () => Date.now();
  const logger = internals.logger && typeof internals.logger.error === 'function'
    ? internals.logger
    : console;
  const calls = new Map();
  const sequences = new Map();
  let queue = Promise.resolve();
  let evidenceFailure = false;

  function enqueue(operation) {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function beforeTool(input, output) {
    try {
      return await enqueue(async () => {
        if (evidenceFailure) {
          throw governanceBlock(
            'evidence_unavailable',
            'deny',
            'Local evidence storage previously failed; no further tool calls are allowed in this plugin instance.',
          );
        }
        return handleBefore(input, output);
      });
    } catch (error) {
      if (error instanceof OpenCodeGovernanceBlock) throw error;
      evidenceFailure = true;
      throw governanceBlock(
        'governance_evaluation_failed',
        'deny',
        'Local governance evaluation or evidence storage failed before tool execution.',
      );
    }
  }

  async function afterTool(input, output) {
    try {
      await enqueue(() => handleAfter(input, output));
    } catch {
      evidenceFailure = true;
      logger.error('[agoragentic/opencode] Local evidence storage failed after tool execution; future calls will fail closed.');
    }
  }

  async function handleBefore(input = {}, output = {}) {
    assertHookIdentity(input);
    const startedMs = readClock(nowMs);
    const loadedPolicy = await loadPolicy();
    const action = mapOpenCodeToolCall(input, output);
    const evaluation = evaluateOpenCodeAction(loadedPolicy, action);
    const identity = hookIdentity(input);
    const runId = stableId('opencode_run', identity.session_ref);
    const callRef = stableId('opencode_call', `${identity.session_ref}:${identity.call_ref}`);
    const inputEvidence = boundedEvidence(output.args ?? {});
    const policyHash = stableHash(loadedPolicy);
    const actionFingerprint = stableHash({
      host: 'opencode',
      session_ref: identity.session_ref,
      tool_name: action.tool_name,
      input_hash: inputEvidence.hash,
      policy_hash: policyHash,
    });
    const reasonCodes = boundedReasonCodes(evaluation.reasons);

    let enforcementDecision = evaluation.decision;
    let approvalState = null;
    if (evaluation.decision === 'ask') {
      approvalState = await resolveApproval({
        run_id: runId,
        call_ref: callRef,
        action,
        evaluation,
        action_fingerprint: actionFingerprint,
        input_evidence: inputEvidence,
        policy_hash: policyHash,
        reason_codes: reasonCodes,
        consumed_at: toIso(startedMs),
      });
      if (approvalState.status === 'approved') enforcementDecision = 'allow_after_local_approval';
      else if (approvalState.status === 'rejected') enforcementDecision = 'deny_after_local_rejection';
      else if (approvalState.status === 'edited') enforcementDecision = 'approval_edit_required';
      else enforcementDecision = 'approval_required';
    }

    const beforeEvent = createHarnessEvent({
      run_id: runId,
      type: 'before_tool',
      severity: enforcementDecision.startsWith('deny') ? 'blocked'
        : enforcementDecision.includes('approval') && enforcementDecision !== 'allow_after_local_approval' ? 'warning'
          : 'info',
      summary: beforeSummary(enforcementDecision),
      created_at: toIso(startedMs),
      sequence: nextSequence(runId),
      data: {
        ledger_schema: OPENCODE_LEDGER_SCHEMA,
        host: 'opencode',
        session_ref: identity.session_ref,
        call_ref: callRef,
        tool_name: sanitizeText(action.tool_name, { maxLength: 120 }),
        capability: action.capability,
        side_effect_class: action.side_effect_class,
        policy_decision: evaluation.decision,
        enforcement_decision: enforcementDecision,
        risk: evaluation.risk,
        reason_codes: reasonCodes,
        action_fingerprint: actionFingerprint,
        policy_hash: policyHash,
        input_evidence: inputEvidence,
        approval_refs: approvalState?.refs || [],
      },
    });
    const ledgerRef = await appendEvent(runId, beforeEvent);

    let proofEvent = beforeEvent;
    if (enforcementDecision === 'approval_required') {
      const approvalEvent = createHarnessEvent({
        run_id: runId,
        type: 'approval_required',
        severity: 'warning',
        summary: 'Bounded local approval packet recorded; tool execution remains blocked pending retry.',
        created_at: toIso(startedMs),
        sequence: nextSequence(runId),
        data: {
          host: 'opencode',
          call_ref: callRef,
          action_fingerprint: actionFingerprint,
          approval_id: approvalState.approval_id,
          approval_refs: approvalState.refs,
        },
      });
      await appendEvent(runId, approvalEvent);
      proofEvent = approvalEvent;
    }

    if (enforcementDecision === 'allow' || enforcementDecision === 'allow_after_local_approval') {
      calls.set(callRef, {
        run_id: runId,
        call_ref: callRef,
        tool_name: sanitizeText(action.tool_name, { maxLength: 120 }),
        capability: action.capability,
        side_effect_class: action.side_effect_class,
        policy_decision: evaluation.decision,
        enforcement_decision: enforcementDecision,
        reason_codes: reasonCodes,
        action_fingerprint: actionFingerprint,
        input_evidence: inputEvidence,
        approval_refs: approvalState?.refs || [],
        before_event_id: beforeEvent.event_id,
        ledger_ref: ledgerRef,
        started_ms: startedMs,
      });
      return;
    }

    const outcomeStatus = enforcementDecision === 'approval_required' ? 'approval_required'
      : enforcementDecision === 'approval_edit_required' ? 'approval_edit_required'
        : enforcementDecision === 'deny_after_local_rejection' ? 'approval_rejected'
          : 'denied';
    const { receipt_ref: receiptRef } = await writeReceipt({
      run_id: runId,
      call_ref: callRef,
      tool_name: sanitizeText(action.tool_name, { maxLength: 120 }),
      capability: action.capability,
      side_effect_class: action.side_effect_class,
      policy_decision: evaluation.decision,
      enforcement_decision: enforcementDecision,
      reason_codes: reasonCodes,
      action_fingerprint: actionFingerprint,
      input_evidence: inputEvidence,
      output_evidence: null,
      approval_refs: approvalState?.refs || [],
      proof_event: proofEvent,
      ledger_ref: ledgerRef,
      created_ms: startedMs,
      duration_ms: 0,
      duration_observed: true,
      outcome_status: outcomeStatus,
      passed: false,
    });

    if (enforcementDecision === 'approval_required') {
      throw new OpenCodeGovernanceBlock(
        `[agoragentic/opencode] Approval ${approvalState.approval_id} is required before tool execution. Review ${approvalState.request_ref}, decide locally, then retry the tool call.`,
        {
          code: 'approval_required',
          decision: 'ask',
          approval_id: approvalState.approval_id,
          receipt_ref: receiptRef,
        },
      );
    }
    if (enforcementDecision === 'approval_edit_required') {
      throw new OpenCodeGovernanceBlock(
        '[agoragentic/opencode] The local approval requested an edited action; retry only with owner-reviewed modified input.',
        {
          code: 'approval_edit_required',
          decision: 'ask',
          approval_id: approvalState.approval_id,
          receipt_ref: receiptRef,
        },
      );
    }
    if (enforcementDecision === 'deny_after_local_rejection') {
      throw new OpenCodeGovernanceBlock(
        '[agoragentic/opencode] The local approval was rejected; tool execution remains blocked.',
        {
          code: 'approval_rejected',
          decision: 'deny',
          approval_id: approvalState.approval_id,
          receipt_ref: receiptRef,
        },
      );
    }
    throw new OpenCodeGovernanceBlock(
      `[agoragentic/opencode] Tool execution denied before execution (${reasonCodes.join(', ') || 'policy_denied'}).`,
      { code: 'policy_denied', decision: 'deny', receipt_ref: receiptRef },
    );
  }

  async function handleAfter(input = {}, output) {
    assertHookIdentity(input);
    const endedMs = readClock(nowMs);
    const identity = hookIdentity(input);
    const runId = stableId('opencode_run', identity.session_ref);
    const callRef = stableId('opencode_call', `${identity.session_ref}:${identity.call_ref}`);
    const previous = calls.get(callRef);
    const governed = Boolean(previous);
    const action = mapOpenCodeToolCall(input, { args: input.args ?? {} });
    const inputEvidence = previous?.input_evidence || boundedEvidence(input.args ?? {});
    const outputEvidence = boundedEvidence(output);
    const ledgerRef = previous?.ledger_ref || relativePath(root, ledgerPath(runId));
    const durationObserved = Boolean(previous);
    const durationMs = previous ? Math.max(0, endedMs - previous.started_ms) : 0;
    const actionFingerprint = previous?.action_fingerprint || stableHash({
      host: 'opencode',
      session_ref: identity.session_ref,
      tool_name: action.tool_name,
      input_hash: inputEvidence.hash,
    });
    const afterEvent = createHarnessEvent({
      run_id: runId,
      type: 'after_tool',
      severity: governed ? 'info' : 'blocked',
      summary: governed
        ? 'OpenCode tool completion recorded as bounded hash-and-shape evidence.'
        : 'OpenCode tool completion arrived without a matching governed before hook; no successful receipt is claimed.',
      created_at: toIso(endedMs),
      sequence: nextSequence(runId),
      data: {
        ledger_schema: OPENCODE_LEDGER_SCHEMA,
        host: 'opencode',
        session_ref: identity.session_ref,
        call_ref: callRef,
        tool_name: previous?.tool_name || sanitizeText(action.tool_name, { maxLength: 120 }),
        capability: previous?.capability || action.capability,
        side_effect_class: previous?.side_effect_class || action.side_effect_class,
        outcome_status: governed ? 'succeeded' : 'ungoverned_after_without_before',
        duration_ms: durationMs,
        duration_observed: durationObserved,
        input_evidence: inputEvidence,
        output_evidence: outputEvidence,
        action_fingerprint: actionFingerprint,
        approval_refs: previous?.approval_refs || [],
        before_event_id: previous?.before_event_id || null,
      },
    });
    await appendEvent(runId, afterEvent);
    const receiptResult = await writeReceipt({
      run_id: runId,
      call_ref: callRef,
      tool_name: previous?.tool_name || sanitizeText(action.tool_name, { maxLength: 120 }),
      capability: previous?.capability || action.capability,
      side_effect_class: previous?.side_effect_class || action.side_effect_class,
      policy_decision: previous?.policy_decision || 'unknown',
      enforcement_decision: previous?.enforcement_decision || 'unknown',
      reason_codes: previous?.reason_codes || [],
      action_fingerprint: actionFingerprint,
      input_evidence: inputEvidence,
      output_evidence: outputEvidence,
      approval_refs: previous?.approval_refs || [],
      proof_event: afterEvent,
      ledger_ref: ledgerRef,
      created_ms: endedMs,
      duration_ms: durationMs,
      duration_observed: durationObserved,
      outcome_status: governed ? 'succeeded' : 'ungoverned_after_without_before',
      passed: governed,
    });
    if (!governed) {
      evidenceFailure = true;
      return;
    }
    if (memoryHandoff) {
      await writeMemoryHandoff({
        run_id: runId,
        call_ref: callRef,
        receipt_id: receiptResult.receipt.receipt_id,
        receipt_ref: receiptResult.receipt_ref,
        ledger_ref: ledgerRef,
        action_fingerprint: actionFingerprint,
        output_hash: outputEvidence.hash,
        created_at: toIso(endedMs),
      });
    }
    calls.delete(callRef);
  }

  async function loadPolicy() {
    if (configuredPolicy !== undefined) {
      if (!configuredPolicy || typeof configuredPolicy !== 'object' || Array.isArray(configuredPolicy)) {
        throw governanceBlock('policy_invalid', 'deny', 'The configured Harness policy must be an object.');
      }
      return configuredPolicy;
    }

    let filePath;
    try {
      filePath = containedPolicyPath(root, configuredPolicyFile);
    } catch {
      throw governanceBlock('policy_path_invalid', 'deny', 'The policy_file option must stay inside the OpenCode project directory.');
    }
    let source;
    try {
      source = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return {};
      throw governanceBlock('policy_unreadable', 'deny', 'The local Harness policy could not be read.');
    }
    try {
      return parseSimpleYaml(source);
    } catch {
      throw governanceBlock('policy_invalid', 'deny', 'The local Harness policy could not be parsed.');
    }
  }

  async function resolveApproval({
    run_id,
    call_ref,
    action,
    evaluation,
    action_fingerprint,
    input_evidence,
    policy_hash,
    reason_codes,
    consumed_at,
  }) {
    const refPath = approvalRefPath(action_fingerprint);
    const existingRef = await readJsonIfExists(refPath);
    if (existingRef && !existingRef.consumed_at) {
      if (!APPROVAL_ID_PATTERN.test(String(existingRef.approval_id || ''))) {
        throw governanceBlock('approval_ref_invalid', 'deny', 'The local approval reference is invalid.');
      }
      const existing = await showApproval(root, existingRef.approval_id);
      if (!existing?.request) {
        throw governanceBlock('approval_state_missing', 'deny', 'The referenced local approval packet is missing.');
      }
      const state = approvalState(existingRef.approval_id, existing);
      if (state.status === 'approved') {
        await writeJson(refPath, {
          ...existingRef,
          consumed_at,
          consumed_for_call_ref: call_ref,
        });
      }
      return state;
    }

    return createApprovalPacket({
      ref_path: refPath,
      run_id,
      action,
      evaluation,
      action_fingerprint,
      input_evidence,
      policy_hash,
      reason_codes,
    });
  }

  async function createApprovalPacket({
    ref_path,
    run_id,
    action,
    evaluation,
    action_fingerprint,
    input_evidence,
    policy_hash,
    reason_codes,
  }) {
    const request = await createApprovalRequest({
      dir: root,
      run_id,
      requested_action: {
        host: 'opencode',
        tool_name: sanitizeText(action.tool_name, { maxLength: 120 }),
        capability: action.capability,
        side_effect_class: action.side_effect_class,
        action_fingerprint,
        policy_hash,
        input_evidence,
        raw_input_persisted: false,
      },
      risk_class: evaluation.risk,
      reason: reason_codes.join(', ') || 'owner_approval_required',
      required_approvals: ['owner'],
      source_event_id: null,
    });
    if (!APPROVAL_ID_PATTERN.test(String(request.approval_id || ''))) {
      throw governanceBlock('approval_id_invalid', 'deny', 'Harness Core returned an invalid local approval identifier.');
    }
    const ref = {
      schema: OPENCODE_APPROVAL_REF_SCHEMA,
      action_fingerprint,
      approval_id: request.approval_id,
      approval_ref: approvalRequestRef(request.approval_id),
      raw_input_persisted: false,
      authority_boundary: authorityBoundary(),
    };
    await writeJson(ref_path, ref);
    return approvalState(request.approval_id, { request, decision: null });
  }

  function approvalState(approvalId, value) {
    const decision = value.decision?.decision;
    const status = decision === 'approve' && value.request.status === 'approved' ? 'approved'
      : decision === 'reject' || value.request.status === 'rejected' ? 'rejected'
        : decision === 'edit' || value.request.status === 'edited' ? 'edited'
          : 'pending';
    const requestRef = approvalRequestRef(approvalId);
    const refs = [requestRef];
    if (value.decision) refs.push(approvalDecisionRef(approvalId));
    return {
      approval_id: approvalId,
      status,
      request_ref: requestRef,
      refs,
    };
  }

  async function appendEvent(runId, event) {
    const filePath = ledgerPath(runId);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.appendFile(filePath, `${JSON.stringify(event)}\n`, 'utf8');
    return relativePath(root, filePath);
  }

  async function writeReceipt(input) {
    const proof = {
      proof_id: input.proof_event.event_id,
      status: input.passed ? 'passed' : 'blocked',
    };
    const project = {
      agent: {
        name: PLUGIN_NAME,
        primary_goal: 'Govern one OpenCode tool call and retain bounded local evidence.',
      },
    };
    const receipt = createLocalReceipt(project, proof, { created_at: toIso(input.created_ms) });
    const localArtifacts = unique([
      input.ledger_ref,
      ...input.approval_refs,
    ]);
    Object.assign(receipt, {
      settlement_status: 'not_settlement_receipt',
      receipt_class: 'local_policy_evidence_only',
      run_id: input.run_id,
      call_ref: input.call_ref,
      outcome_status: input.outcome_status,
      duration_ms: input.duration_ms,
      duration_observed: input.duration_observed,
      hashes: {
        action: input.action_fingerprint,
        input: input.input_evidence.hash,
        output: input.output_evidence?.hash || null,
      },
      evidence_refs: localArtifacts,
      approval_refs: [...input.approval_refs],
      proof_ref: `${input.ledger_ref}#${input.proof_event.event_id}`,
      receipt_claims: {
        local_policy_and_evidence_only: true,
        settlement_receipt: false,
        certification: false,
        endorsement: false,
        marketplace_verification: false,
      },
      authority_boundary: authorityBoundary(),
      public_boundary: {
        spend_triggered: false,
        settlement_triggered: false,
        payout_triggered: false,
        publication_triggered: false,
        hosted_provisioning_triggered: false,
        x402_route_created: false,
      },
    });
    receipt.evidence = {
      agent_name: PLUGIN_NAME,
      primary_goal: project.agent.primary_goal,
      proof_status: proof.status,
      local_artifacts: localArtifacts,
      host: 'opencode',
      tool_name: input.tool_name,
      capability: input.capability,
      side_effect_class: input.side_effect_class,
      policy_decision: input.policy_decision,
      enforcement_decision: input.enforcement_decision,
      reason_codes: input.reason_codes,
      input_evidence: input.input_evidence,
      output_evidence: input.output_evidence,
      raw_tool_input_persisted: false,
      raw_tool_output_persisted: false,
    };
    receipt.receipt_boundary = {
      ...receipt.receipt_boundary,
      certification_created: false,
      endorsement_created: false,
      marketplace_verification_created: false,
      trust_mutated: false,
    };

    const receiptPath = path.join(runRoot(input.run_id), 'receipts', `${receipt.receipt_id}.json`);
    await writeJson(receiptPath, receipt);
    return { receipt, receipt_ref: relativePath(root, receiptPath) };
  }

  async function writeMemoryHandoff(input) {
    const packet = {
      schema: OPENCODE_HANDOFF_SCHEMA,
      created_at: input.created_at,
      status: 'local_candidate_only',
      destination: 'agoragentic_memory_optional_import',
      run_id: input.run_id,
      call_ref: input.call_ref,
      receipt_id: input.receipt_id,
      receipt_ref: input.receipt_ref,
      ledger_ref: input.ledger_ref,
      action_fingerprint: input.action_fingerprint,
      output_hash: input.output_hash,
      raw_input_included: false,
      raw_output_included: false,
      memory_write_performed: false,
      authority_boundary: authorityBoundary(),
    };
    const filePath = path.join(runRoot(input.run_id), 'handoffs', `${input.receipt_id}.json`);
    await writeJson(filePath, packet);
  }

  async function readJsonIfExists(filePath) {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function writeJson(filePath, value) {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  }

  function approvalRefPath(actionFingerprint) {
    return path.join(root, '.agoragentic', 'opencode', 'approval-refs', `${stableId('action', actionFingerprint)}.json`);
  }

  function ledgerPath(runId) {
    return path.join(runRoot(runId), 'events.jsonl');
  }

  function runRoot(runId) {
    return path.join(root, '.agoragentic', 'opencode', 'runs', runId);
  }

  function nextSequence(runId) {
    const next = Number(sequences.get(runId) || 0) + 1;
    sequences.set(runId, next);
    return next;
  }

  return {
    'tool.execute.before': beforeTool,
    'tool.execute.after': afterTool,
  };
}

export function boundedEvidence(value) {
  let hash;
  let hashComplete = true;
  try {
    hash = stableHash(value);
  } catch {
    hash = stableHash({ unhashable_type: valueType(value) });
    hashComplete = false;
  }
  return {
    hash,
    hash_complete: hashComplete,
    serialized_bytes: serializedBytes(value),
    value_type: valueType(value),
    field_count: value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).length : null,
    storage: 'hash_and_shape_only',
    raw_value_persisted: false,
  };
}

function assertHookIdentity(input) {
  if (!input || typeof input !== 'object'
    || typeof input.tool !== 'string' || !input.tool
    || typeof input.sessionID !== 'string' || !input.sessionID
    || typeof input.callID !== 'string' || !input.callID) {
    throw governanceBlock(
      'opencode_contract_invalid',
      'deny',
      'OpenCode did not provide the pinned tool hook identity fields; execution is blocked.',
    );
  }
}

function hookIdentity(input) {
  return {
    session_ref: stableId('session', input.sessionID),
    call_ref: stableId('call', input.callID),
  };
}

function boundedReasonCodes(reasons = []) {
  return unique(reasons
    .map((reason) => sanitizeText(reason?.code || 'policy_reason', { maxLength: 80 }))
    .filter(Boolean))
    .slice(0, MAX_REASON_CODES);
}

function beforeSummary(decision) {
  if (decision === 'allow') return 'OpenCode tool call allowed by local Harness policy.';
  if (decision === 'allow_after_local_approval') return 'OpenCode tool call allowed on retry after a matching local approval.';
  if (decision === 'approval_required') return 'OpenCode tool call blocked pending a bounded local approval packet.';
  if (decision === 'approval_edit_required') return 'OpenCode tool call blocked until owner-reviewed edited input is retried.';
  if (decision === 'deny_after_local_rejection') return 'OpenCode tool call blocked after local approval rejection.';
  return 'OpenCode tool call denied by local Harness policy before execution.';
}

function governanceBlock(code, decision, message) {
  return new OpenCodeGovernanceBlock(`[agoragentic/opencode] ${message}`, { code, decision });
}

function containedPolicyPath(root, value) {
  const relative = String(value || 'policy.yaml');
  if (path.isAbsolute(relative)) throw new Error('absolute policy path');
  const resolved = path.resolve(root, relative);
  const containment = path.relative(root, resolved);
  if (containment === '..' || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new Error('policy path escapes project');
  }
  return resolved;
}

function readClock(nowMs) {
  const value = Number(nowMs());
  return Number.isFinite(value) ? value : Date.now();
}

function toIso(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function serializedBytes(value) {
  try {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized, 'utf8') : null;
  } catch {
    return null;
  }
}

function valueType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function approvalRequestRef(approvalId) {
  return `.agoragentic/approvals/${approvalId}.json`;
}

function approvalDecisionRef(approvalId) {
  return `.agoragentic/approvals/${approvalId}.decision.json`;
}

function relativePath(root, filePath) {
  return path.relative(root, filePath).replace(/\\/g, '/');
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}
