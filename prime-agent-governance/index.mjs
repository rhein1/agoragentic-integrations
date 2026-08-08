import { createHash, randomUUID } from 'node:crypto';

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|seed|token|payment[_-]?signature|wallet[_-]?private)/i;
const SPEND_PATTERN = /(pay|payment|purchase|charge|transfer|send[_-]?funds|wallet|settle|payout|refund)/i;
const DEPLOY_PATTERN = /(deploy|provision|release|publish|push[_-]?image|create[_-]?pod|start[_-]?service)/i;
const TRUST_PATTERN = /(trust|rank|reputation|verify[_-]?seller|approve[_-]?listing)/i;
const WRITE_PATTERN = /(write|edit|patch|delete|remove|rename|move|mkdir|create[_-]?file|git[_-]?commit|git[_-]?push)/i;
const NETWORK_PATTERN = /(fetch|http|request|browser|web|mcp|ssh|curl|wget|email|message|slack|discord)/i;
const READ_PATTERN = /(read|list|search|find|inspect|status|show|view|grep|cat|head|tail)/i;

export const DEFAULT_POLICY = Object.freeze({
  policy_id: 'agoragentic.prime-agent.local.v1',
  allow_read_only: true,
  require_interactive_review_for: Object.freeze(['write', 'network']),
  require_principal_authority_for: Object.freeze(['spend', 'deploy', 'publish', 'trust']),
  denied_capabilities: Object.freeze([
    'wallet.fund',
    'wallet.export_private_material',
    'authority.self_approve',
    'authority.expand_scope',
    'trust.mutate',
  ]),
  allowed_capabilities: Object.freeze([]),
  max_evidence_events: 500,
  max_string_length: 2000,
});

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value, fallback = '', maxLength = 2000) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  return text ? text.slice(0, maxLength) : fallback;
}

function stableSort(value) {
  if (Array.isArray(value)) return value.map(stableSort);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableSort(value[key])]),
  );
}

export function canonicalize(value) {
  return JSON.stringify(stableSort(value));
}

export function hashValue(value) {
  const input = typeof value === 'string' ? value : canonicalize(value);
  return `sha256:${createHash('sha256').update(input, 'utf8').digest('hex')}`;
}

export function sanitizeEvidence(value, options = {}, depth = 0) {
  const maxDepth = Number.isInteger(options.maxDepth) ? options.maxDepth : 6;
  const maxItems = Number.isInteger(options.maxItems) ? options.maxItems : 100;
  const maxStringLength = Number.isInteger(options.maxStringLength)
    ? options.maxStringLength
    : DEFAULT_POLICY.max_string_length;

  if (depth > maxDepth) return '[TRUNCATED_DEPTH]';
  if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') return value.slice(0, maxStringLength);
  if (Array.isArray(value)) {
    return value.slice(0, maxItems).map((entry) => sanitizeEvidence(entry, options, depth + 1));
  }
  if (!isPlainObject(value)) return normalizeString(value, '[UNSERIALIZABLE]', maxStringLength);

  const output = {};
  for (const [key, child] of Object.entries(value).slice(0, maxItems)) {
    output[key] = SECRET_KEY_PATTERN.test(key)
      ? '[REDACTED]'
      : sanitizeEvidence(child, options, depth + 1);
  }
  return output;
}

function normalizedToolText(event = {}) {
  return [
    event.toolName,
    event.name,
    event.input?.command,
    event.input?.path,
    event.input?.url,
    event.input?.action,
  ]
    .map((value) => normalizeString(value).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

export function classifyPrimeToolCall(event = {}) {
  const toolName = normalizeString(event.toolName || event.name, 'unknown');
  const text = normalizedToolText(event);
  let sideEffectClass = 'unknown';
  let capability = `tool.${toolName}`;

  if (SPEND_PATTERN.test(text)) {
    sideEffectClass = 'spend';
    capability = text.includes('fund') ? 'wallet.fund' : 'payment.execute';
  } else if (TRUST_PATTERN.test(text)) {
    sideEffectClass = 'trust';
    capability = 'trust.mutate';
  } else if (DEPLOY_PATTERN.test(text)) {
    sideEffectClass = text.includes('publish') ? 'publish' : 'deploy';
    capability = sideEffectClass === 'publish' ? 'publication.execute' : 'deployment.execute';
  } else if (WRITE_PATTERN.test(text) || ['write', 'edit', 'bash', 'shell'].includes(toolName.toLowerCase())) {
    sideEffectClass = 'write';
    capability = toolName.toLowerCase().includes('git') ? 'repository.mutate' : 'workspace.mutate';
  } else if (NETWORK_PATTERN.test(text)) {
    sideEffectClass = 'network';
    capability = 'network.request';
  } else if (READ_PATTERN.test(text)) {
    sideEffectClass = 'read';
    capability = 'workspace.read';
  }

  return Object.freeze({
    tool_name: toolName,
    capability,
    side_effect_class: sideEffectClass,
    input_hash: hashValue(sanitizeEvidence(event.input ?? {})),
  });
}

function authorityAllows(authority, capability, classification, now = new Date()) {
  if (!isPlainObject(authority) || authority.status !== 'active') return false;
  const expiry = Date.parse(authority.expires_at || '');
  if (Number.isFinite(expiry) && expiry <= now.getTime()) return false;
  const allowed = Array.isArray(authority.allowed_capabilities) ? authority.allowed_capabilities : [];
  const allowedClasses = Array.isArray(authority.allowed_side_effect_classes)
    ? authority.allowed_side_effect_classes
    : [];
  return allowed.includes(capability) || allowedClasses.includes(classification);
}

export function evaluatePrimeToolCall(event, context = {}, policy = DEFAULT_POLICY) {
  const classification = classifyPrimeToolCall(event);
  const denied = new Set(policy.denied_capabilities || []);
  const explicitlyAllowed = new Set(policy.allowed_capabilities || []);
  const principalRequired = new Set(policy.require_principal_authority_for || []);
  const reviewRequired = new Set(policy.require_interactive_review_for || []);

  let decision = 'deny';
  let reason = 'unknown tool effect; explicit review is required';

  if (denied.has(classification.capability)) {
    decision = 'deny';
    reason = `capability ${classification.capability} is denied by policy`;
  } else if (classification.side_effect_class === 'read' && policy.allow_read_only === true) {
    decision = 'allow';
    reason = 'read-only action allowed by local policy';
  } else if (explicitlyAllowed.has(classification.capability)) {
    decision = 'allow';
    reason = 'capability explicitly allowed by local policy';
  } else if (principalRequired.has(classification.side_effect_class)) {
    if (authorityAllows(
      context.authority,
      classification.capability,
      classification.side_effect_class,
      context.now ? new Date(context.now) : new Date(),
    )) {
      decision = 'allow';
      reason = 'active principal authority covers this exact capability or side-effect class';
    } else {
      decision = 'deny';
      reason = 'principal authority is missing, expired, or out of scope';
    }
  } else if (reviewRequired.has(classification.side_effect_class)) {
    decision = 'ask';
    reason = 'local policy requires interactive review before this side effect';
  }

  return Object.freeze({
    schema: 'agoragentic.prime-agent.policy-decision.v1',
    decision,
    reason,
    classification,
    evaluated_at: new Date().toISOString(),
    authority_granted_by_decision: false,
  });
}

export function buildAuthorityRequest(input = {}) {
  const principalRef = normalizeString(input.principal_ref || input.principalRef);
  const agentRef = normalizeString(input.agent_ref || input.agentRef);
  const purpose = normalizeString(input.purpose);
  const capabilities = [...new Set((input.allowed_capabilities || input.allowedCapabilities || [])
    .map((value) => normalizeString(value))
    .filter(Boolean))];
  if (!principalRef) throw new TypeError('principal_ref is required');
  if (!agentRef) throw new TypeError('agent_ref is required');
  if (!purpose) throw new TypeError('purpose is required');
  if (capabilities.length === 0) throw new TypeError('at least one allowed capability is required');

  const createdAt = new Date(input.created_at || input.createdAt || Date.now());
  if (Number.isNaN(createdAt.getTime())) throw new TypeError('created_at must be a valid date');
  const expiresAt = new Date(input.expires_at || input.expiresAt || createdAt.getTime() + 60 * 60 * 1000);
  if (Number.isNaN(expiresAt.getTime())) throw new TypeError('expires_at must be a valid date');

  return Object.freeze({
    schema: 'agoragentic.prime-agent.authority-request.v1',
    request_id: normalizeString(input.request_id || input.requestId, `par_${randomUUID()}`),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    principal_ref: principalRef,
    agent_ref: agentRef,
    purpose,
    requested_authority: {
      allowed_capabilities: capabilities,
      allowed_side_effect_classes: [...new Set((input.allowed_side_effect_classes || [])
        .map((value) => normalizeString(value))
        .filter(Boolean))],
      max_amount: normalizeString(input.max_amount || input.maxAmount, '0'),
      currency: normalizeString(input.currency, 'USD', 20),
    },
    status: 'pending_principal_approval',
    request_grants_authority: false,
    can_self_approve: false,
    can_fund_wallet: false,
    can_expand_scope: false,
  });
}

export function createLocalReceipt(state, status = 'completed') {
  const events = Array.isArray(state.events) ? state.events : [];
  return Object.freeze({
    schema: 'agoragentic.prime-agent.local-receipt.v1',
    receipt_id: `parc_${randomUUID()}`,
    run_id: state.run_id || null,
    session_id: state.session_id || null,
    status,
    event_count: events.length,
    event_chain_hash: hashValue(events),
    latest_policy_decision: state.latest_policy_decision || null,
    created_at: new Date().toISOString(),
    local_receipt_only: true,
    settlement_receipt: false,
    certification: false,
    marketplace_verification: false,
    trust_endorsement: false,
    authority_granted: false,
  });
}

function appendBoundedEvent(state, event, policy) {
  const max = Number.isInteger(policy.max_evidence_events) ? policy.max_evidence_events : 500;
  const bounded = sanitizeEvidence({
    id: `evt_${randomUUID()}`,
    at: new Date().toISOString(),
    ...event,
  });
  state.events.push(bounded);
  if (state.events.length > max) state.events.splice(0, state.events.length - max);
  return bounded;
}

function maybeAppendPrimeEntry(pi, type, data) {
  if (typeof pi.appendEntry !== 'function') return;
  pi.appendEntry(type, sanitizeEvidence(data));
}

export function createAgoragenticPrimeExtension(options = {}) {
  const policy = Object.freeze({ ...DEFAULT_POLICY, ...(options.policy || {}) });
  const state = {
    run_id: null,
    session_id: null,
    authority: options.authority || null,
    events: [],
    latest_policy_decision: null,
    latest_receipt: null,
  };

  return function install(pi) {
    if (!pi || typeof pi.on !== 'function') {
      throw new TypeError('Prime Agent ExtensionAPI with on() is required');
    }

    pi.on('session_start', async (event = {}) => {
      state.run_id = `parun_${randomUUID()}`;
      state.session_id = normalizeString(event.sessionId || event.session_id || event.sessionFile, state.run_id);
      const recorded = appendBoundedEvent(state, {
        type: 'session_started',
        reason: event.reason || 'unknown',
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.session', recorded);
    });

    pi.on('before_agent_start', async () => {
      const recorded = appendBoundedEvent(state, {
        type: 'agent_start_requested',
        authority_status: state.authority?.status || 'missing',
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.agent', recorded);
    });

    pi.on('tool_call', async (event = {}, ctx = {}) => {
      const decision = evaluatePrimeToolCall(event, { authority: state.authority }, policy);
      state.latest_policy_decision = decision;
      const recorded = appendBoundedEvent(state, {
        type: 'tool_policy_decision',
        tool_name: decision.classification.tool_name,
        capability: decision.classification.capability,
        side_effect_class: decision.classification.side_effect_class,
        input_hash: decision.classification.input_hash,
        decision: decision.decision,
        reason: decision.reason,
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.policy', recorded);

      if (decision.decision === 'deny') {
        return { block: true, reason: decision.reason };
      }
      if (decision.decision === 'ask') {
        if (!ctx.hasUI || !ctx.ui || typeof ctx.ui.confirm !== 'function') {
          return { block: true, reason: `${decision.reason}; no interactive principal review is available` };
        }
        const approved = await ctx.ui.confirm(
          'Agoragentic policy review',
          `${decision.classification.tool_name}: ${decision.reason}`,
        );
        appendBoundedEvent(state, {
          type: 'interactive_review',
          capability: decision.classification.capability,
          approved: approved === true,
        }, policy);
        if (approved !== true) return { block: true, reason: 'blocked by interactive principal review' };
      }
      return undefined;
    });

    pi.on('tool_result', async (event = {}) => {
      const recorded = appendBoundedEvent(state, {
        type: 'tool_result_observed',
        tool_name: normalizeString(event.toolName || event.name, 'unknown'),
        result_hash: hashValue(sanitizeEvidence(event.result ?? event.output ?? event.content ?? null)),
        is_error: event.isError === true || event.error === true,
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.evidence', recorded);
      return undefined;
    });

    pi.on('session_before_compact', async () => {
      const recorded = appendBoundedEvent(state, {
        type: 'pre_compaction_checkpoint',
        event_chain_hash: hashValue(state.events),
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.checkpoint', recorded);
    });

    pi.on('agent_end', async (event = {}) => {
      appendBoundedEvent(state, {
        type: 'agent_ended',
        reason: event.reason || event.stopReason || 'unknown',
      }, policy);
      state.latest_receipt = createLocalReceipt(state, 'completed');
      maybeAppendPrimeEntry(pi, 'agoragentic.receipt', state.latest_receipt);
    });

    pi.on('session_shutdown', async () => {
      if (!state.latest_receipt) {
        state.latest_receipt = createLocalReceipt(state, 'incomplete');
        maybeAppendPrimeEntry(pi, 'agoragentic.receipt', state.latest_receipt);
      }
    });

    if (typeof pi.registerCommand === 'function') {
      pi.registerCommand('agora-status', {
        description: 'Show the local Agoragentic policy and receipt state for this Prime Agent session.',
        handler: async (_args, ctx = {}) => {
          const summary = {
            run_id: state.run_id,
            session_id: state.session_id,
            authority_status: state.authority?.status || 'missing',
            event_count: state.events.length,
            latest_decision: state.latest_policy_decision?.decision || null,
            latest_receipt_id: state.latest_receipt?.receipt_id || null,
            authority_granted_by_extension: false,
          };
          if (ctx.ui && typeof ctx.ui.notify === 'function') {
            ctx.ui.notify(JSON.stringify(summary, null, 2), 'info');
          }
          return summary;
        },
      });
    }

    if (typeof pi.registerTool === 'function') {
      pi.registerTool({
        name: 'agoragentic_status',
        label: 'Agoragentic Status',
        description: 'Read the local policy, authority, evidence, and receipt status. This tool grants no authority.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        async execute() {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                run_id: state.run_id,
                authority_status: state.authority?.status || 'missing',
                event_count: state.events.length,
                latest_policy_decision: state.latest_policy_decision,
                latest_receipt: state.latest_receipt,
                authority_granted: false,
              }, null, 2),
            }],
            details: {},
          };
        },
      });
    }

    return Object.freeze({ state, policy });
  };
}

export default createAgoragenticPrimeExtension();
