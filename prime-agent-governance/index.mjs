import { createHash, randomUUID } from 'node:crypto';

const SECRET_KEY_PATTERN = /(api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|seed|token|payment[_-]?signature|wallet[_-]?private)/i;
const SPEND_PATTERN = /(pay|payment|purchase|charge|transfer|send[_-]?funds|wallet|settle|payout|refund|usdc|eth_sendtransaction|sendtransaction|signandsend)/i;
const PUBLISH_PATTERN = /(publish|release|git(?:\s+|[_-])push|npm\s+publish|gh\s+release)/i;
const DEPLOY_PATTERN = /(deploy|provision|push[_-]?image|create[_-]?pod|start[_-]?service|kubectl\s+(apply|create|delete|patch|replace|rollout)|helm\s+(install|upgrade|uninstall)|terraform\s+(apply|destroy)|docker\s+(push|run)|systemctl\s+(start|restart|enable))/i;
const TRUST_PATTERN = /(trust|rank|reputation|verify[_-]?seller|approve[_-]?listing|gh\s+pr\s+(merge|review)|merge[_ -]?pull[_ -]?request)/i;
const WRITE_PATTERN = /(write|edit|patch|delete|remove|rename|move|mkdir|create[_-]?file|git[_-]?commit|git[_-]?push)/i;
const NETWORK_PATTERN = /(fetch|http|request|browser|web|mcp|ssh|curl|wget|email|message|slack|discord)/i;
const AUTHORITY_GRANT_SCHEMA = 'agoragentic.prime-agent.authority-grant.v1';
const AUTHORITY_BINDING_SCHEMA = 'agoragentic.prime-agent.authority-binding.v1';
const DEFAULT_AUTHORITY_TTL_MS = 15 * 60 * 1000;
const IPYTHON_CODE_MAX_LENGTH = 100_000;
const READ_ONLY_IPYTHON_EXPRESSION = /^[\d\s()+\-*/%.,:[\]{}'"_<>=!&|^~]+$/;
const HIGH_IMPACT_SIDE_EFFECT_CLASSES = Object.freeze(['spend', 'deploy', 'publish', 'trust']);
const ABSOLUTE_DENIED_CAPABILITIES = Object.freeze([
  'wallet.fund',
  'wallet.export_private_material',
  'authority.self_approve',
  'authority.expand_scope',
  'trust.mutate',
]);

export const DEFAULT_POLICY = Object.freeze({
  policy_id: 'agoragentic.prime-agent.local.v1',
  allow_read_only: true,
  require_interactive_review_for: Object.freeze(['write', 'network']),
  require_principal_authority_for: HIGH_IMPACT_SIDE_EFFECT_CLASSES,
  denied_capabilities: ABSOLUTE_DENIED_CAPABILITIES,
  allowed_capabilities: Object.freeze([]),
  max_authority_ttl_ms: DEFAULT_AUTHORITY_TTL_MS,
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
    normalizeString(event.input?.code, '', IPYTHON_CODE_MAX_LENGTH),
    event.input?.path,
    event.input?.url,
    event.input?.action,
  ]
    .map((value) => normalizeString(value, '', IPYTHON_CODE_MAX_LENGTH).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function isObviouslyReadOnlyIpythonCode(value) {
  if (typeof value !== 'string' || value.length > IPYTHON_CODE_MAX_LENGTH) return false;
  const code = normalizeString(value, '', IPYTHON_CODE_MAX_LENGTH);
  return Boolean(code) && READ_ONLY_IPYTHON_EXPRESSION.test(code);
}

export function classifyPrimeToolCall(event = {}) {
  const toolName = normalizeString(event.toolName || event.name, 'unknown');
  const normalizedToolName = toolName.toLowerCase();
  const text = normalizedToolText(event);
  const toolCallId = normalizeString(event.toolCallId || event.tool_call_id, '', 500) || null;
  const inputHash = hashValue(event.input ?? {});
  let sideEffectClass = 'unknown';
  let capability = `tool.${toolName}`;

  if (SPEND_PATTERN.test(text)) {
    sideEffectClass = 'spend';
    capability = text.includes('fund') ? 'wallet.fund' : 'payment.execute';
  } else if (TRUST_PATTERN.test(text)) {
    sideEffectClass = 'trust';
    capability = 'trust.mutate';
  } else if (PUBLISH_PATTERN.test(text)) {
    sideEffectClass = 'publish';
    capability = 'publication.execute';
  } else if (DEPLOY_PATTERN.test(text)) {
    sideEffectClass = 'deploy';
    capability = 'deployment.execute';
  } else if (WRITE_PATTERN.test(text) || ['write', 'edit'].includes(normalizedToolName)) {
    sideEffectClass = 'write';
    capability = normalizedToolName.includes('git') ? 'repository.mutate' : 'workspace.mutate';
  } else if (NETWORK_PATTERN.test(text)) {
    sideEffectClass = 'network';
    capability = 'network.request';
  } else if (normalizedToolName === 'ipython' && isObviouslyReadOnlyIpythonCode(event.input?.code)) {
    sideEffectClass = 'read';
    capability = 'workspace.read';
  } else if (normalizedToolName === 'agoragentic_status') {
    sideEffectClass = 'read';
    capability = 'workspace.read';
  }

  return Object.freeze({
    tool_name: toolName,
    tool_call_id: toolCallId,
    capability,
    side_effect_class: sideEffectClass,
    input_hash: inputHash,
  });
}

export function buildAuthorityBinding(event, context = {}) {
  const classification = classifyPrimeToolCall(event);
  const fields = {
    schema: AUTHORITY_BINDING_SCHEMA,
    principal_ref: normalizeString(context.principal_ref || context.principalRef),
    agent_ref: normalizeString(context.agent_ref || context.agentRef),
    session_ref: normalizeString(context.session_ref || context.sessionRef),
    tool_call_id: classification.tool_call_id,
    capability: classification.capability,
    side_effect_class: classification.side_effect_class,
    input_hash: classification.input_hash,
  };
  return Object.freeze({ ...fields, action_hash: hashValue(fields) });
}

function invalidAuthority(reason, authorityId = null) {
  return Object.freeze({ valid: false, reason, authority_id: authorityId });
}

export function validatePrincipalAuthority(authority, binding, options = {}) {
  const authorityId = normalizeString(authority?.authority_id || authority?.authorityId) || null;
  if (!isPlainObject(authority)) return invalidAuthority('principal authority is missing');
  if (authority.schema !== AUTHORITY_GRANT_SCHEMA) {
    return invalidAuthority(`principal authority must use ${AUTHORITY_GRANT_SCHEMA}`, authorityId);
  }
  if (!authorityId) return invalidAuthority('principal authority_id is required');
  if (authority.status !== 'active') return invalidAuthority('principal authority is not active', authorityId);
  if (!isPlainObject(binding)) return invalidAuthority('authority binding is missing', authorityId);

  for (const field of ['principal_ref', 'agent_ref', 'session_ref', 'tool_call_id', 'action_hash']) {
    if (!normalizeString(binding[field])) {
      return invalidAuthority(`authority binding ${field} is required`, authorityId);
    }
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  if (Number.isNaN(now.getTime())) return invalidAuthority('authority evaluation time is invalid', authorityId);
  const issuedAt = new Date(authority.issued_at || '');
  const expiresAt = new Date(authority.expires_at || '');
  if (Number.isNaN(issuedAt.getTime())) return invalidAuthority('principal authority issued_at is invalid', authorityId);
  if (Number.isNaN(expiresAt.getTime())) return invalidAuthority('principal authority expires_at is invalid', authorityId);
  if (issuedAt.getTime() > now.getTime()) return invalidAuthority('principal authority is not active yet', authorityId);
  if (expiresAt.getTime() <= now.getTime()) return invalidAuthority('principal authority is expired', authorityId);
  if (expiresAt.getTime() <= issuedAt.getTime()) {
    return invalidAuthority('principal authority expiry must follow issuance', authorityId);
  }

  const maxTtlMs = Number.isInteger(options.maxTtlMs) && options.maxTtlMs > 0
    ? Math.min(options.maxTtlMs, DEFAULT_AUTHORITY_TTL_MS)
    : DEFAULT_AUTHORITY_TTL_MS;
  if (expiresAt.getTime() - issuedAt.getTime() > maxTtlMs) {
    return invalidAuthority(`principal authority exceeds the ${maxTtlMs}ms lifetime limit`, authorityId);
  }

  for (const field of ['principal_ref', 'agent_ref', 'session_ref', 'action_hash']) {
    if (normalizeString(authority[field]) !== normalizeString(binding[field])) {
      return invalidAuthority(`principal authority ${field} does not match this action`, authorityId);
    }
  }

  const allowed = Array.isArray(authority.allowed_capabilities)
    ? authority.allowed_capabilities.map((value) => normalizeString(value)).filter(Boolean)
    : [];
  if (!allowed.includes(binding.capability)) {
    return invalidAuthority('principal authority does not cover this exact capability', authorityId);
  }

  if (typeof options.verifyAuthority !== 'function') {
    return invalidAuthority('trusted principal-authority verifier is required', authorityId);
  }
  let verified = false;
  try {
    verified = options.verifyAuthority(authority, binding);
  } catch {
    return invalidAuthority('trusted principal-authority verifier failed', authorityId);
  }
  if (verified && typeof verified.then === 'function') {
    return invalidAuthority('trusted principal-authority verifier must be synchronous', authorityId);
  }
  if (verified !== true) return invalidAuthority('principal authority integrity verification failed', authorityId);

  if (typeof options.isAuthorityConsumed !== 'function') {
    return invalidAuthority('trusted principal-authority replay guard is required', authorityId);
  }
  let consumed = false;
  try {
    consumed = options.isAuthorityConsumed(authorityId, binding);
  } catch {
    return invalidAuthority('trusted principal-authority replay guard failed', authorityId);
  }
  if (consumed && typeof consumed.then === 'function') {
    return invalidAuthority('trusted principal-authority replay guard must be synchronous', authorityId);
  }
  if (consumed !== false) return invalidAuthority('principal authority or action was already consumed', authorityId);

  return Object.freeze({ valid: true, reason: 'principal authority is valid for this exact action', authority_id: authorityId });
}

export function evaluatePrimeToolCall(event, context = {}, policy = DEFAULT_POLICY) {
  const classification = classifyPrimeToolCall(event);
  const binding = buildAuthorityBinding(event, context);
  const denied = new Set([...ABSOLUTE_DENIED_CAPABILITIES, ...(policy.denied_capabilities || [])]);
  const explicitlyAllowed = new Set(policy.allowed_capabilities || []);
  const principalRequired = new Set([
    ...HIGH_IMPACT_SIDE_EFFECT_CLASSES,
    ...(policy.require_principal_authority_for || []),
  ]);
  const reviewRequired = new Set(policy.require_interactive_review_for || []);
  const evaluatedAt = context.now ? new Date(context.now) : new Date();

  let decision = 'deny';
  let reason = 'unknown tool effect; explicit review is required';
  let authorityValidation = null;

  if (denied.has(classification.capability)) {
    decision = 'deny';
    reason = `capability ${classification.capability} is denied by policy`;
  } else if (classification.side_effect_class === 'read' && policy.allow_read_only === true) {
    decision = 'allow';
    reason = 'read-only action allowed by local policy';
  } else if (principalRequired.has(classification.side_effect_class)) {
    authorityValidation = validatePrincipalAuthority(context.authority, binding, {
      now: evaluatedAt,
      maxTtlMs: policy.max_authority_ttl_ms,
      verifyAuthority: context.verifyAuthority,
      isAuthorityConsumed: context.isAuthorityConsumed,
    });
    if (authorityValidation.valid) {
      decision = 'allow';
      reason = 'verified principal authority covers this exact principal, session, and action';
    } else {
      decision = 'deny';
      reason = authorityValidation.reason;
    }
  } else if (explicitlyAllowed.has(classification.capability)) {
    decision = 'allow';
    reason = 'capability explicitly allowed by local policy';
  } else if (reviewRequired.has(classification.side_effect_class)) {
    decision = 'ask';
    reason = 'local policy requires interactive review before this side effect';
  }

  return Object.freeze({
    schema: 'agoragentic.prime-agent.policy-decision.v1',
    decision,
    reason,
    classification,
    authority_binding: principalRequired.has(classification.side_effect_class) ? binding : null,
    authority_validation: authorityValidation,
    evaluated_at: Number.isNaN(evaluatedAt.getTime()) ? new Date().toISOString() : evaluatedAt.toISOString(),
    authority_granted_by_decision: false,
  });
}

export function buildAuthorityRequest(input = {}) {
  const principalRef = normalizeString(input.principal_ref || input.principalRef);
  const agentRef = normalizeString(input.agent_ref || input.agentRef);
  const sessionRef = normalizeString(input.session_ref || input.sessionRef);
  const actionHash = normalizeString(input.action_hash || input.actionHash);
  const purpose = normalizeString(input.purpose);
  const capabilities = [...new Set((input.allowed_capabilities || input.allowedCapabilities || [])
    .map((value) => normalizeString(value))
    .filter(Boolean))];
  if (!principalRef) throw new TypeError('principal_ref is required');
  if (!agentRef) throw new TypeError('agent_ref is required');
  if (!sessionRef) throw new TypeError('session_ref is required');
  if (!/^sha256:[a-f0-9]{64}$/.test(actionHash)) throw new TypeError('action_hash must be a sha256 reference');
  if (!purpose) throw new TypeError('purpose is required');
  if (capabilities.length === 0) throw new TypeError('at least one allowed capability is required');

  const createdAt = new Date(input.created_at || input.createdAt || Date.now());
  if (Number.isNaN(createdAt.getTime())) throw new TypeError('created_at must be a valid date');
  const expiresAt = new Date(input.expires_at || input.expiresAt || createdAt.getTime() + DEFAULT_AUTHORITY_TTL_MS);
  if (Number.isNaN(expiresAt.getTime())) throw new TypeError('expires_at must be a valid date');
  if (expiresAt.getTime() <= createdAt.getTime()) throw new TypeError('expires_at must follow created_at');
  if (expiresAt.getTime() - createdAt.getTime() > DEFAULT_AUTHORITY_TTL_MS) {
    throw new TypeError(`authority request lifetime must not exceed ${DEFAULT_AUTHORITY_TTL_MS}ms`);
  }

  return Object.freeze({
    schema: 'agoragentic.prime-agent.authority-request.v1',
    request_id: normalizeString(input.request_id || input.requestId, `par_${randomUUID()}`),
    created_at: createdAt.toISOString(),
    expires_at: expiresAt.toISOString(),
    principal_ref: principalRef,
    agent_ref: agentRef,
    session_ref: sessionRef,
    action_hash: actionHash,
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
  const configuredPrincipalRef = normalizeString(options.principal_ref || options.principalRef);
  const configuredAgentRef = normalizeString(options.agent_ref || options.agentRef);
  const configuredSessionRef = normalizeString(options.session_ref || options.sessionRef);
  const state = {
    run_id: null,
    session_id: null,
    principal_ref: configuredPrincipalRef || null,
    agent_ref: configuredAgentRef || null,
    authority: options.authority || null,
    latest_authority_id: null,
    latest_authority_status: options.authority ? 'unverified' : 'missing',
    consumed_authority_ids: new Set(),
    consumed_action_hashes: new Set(),
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
      state.session_id = configuredSessionRef || state.run_id;
      const recorded = appendBoundedEvent(state, {
        type: 'session_started',
        reason: event.reason || 'unknown',
        previous_session_file_hash: event.previousSessionFile
          ? hashValue(normalizeString(event.previousSessionFile))
          : null,
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.session', recorded);
    });

    pi.on('before_agent_start', async () => {
      const recorded = appendBoundedEvent(state, {
        type: 'agent_start_requested',
        authority_status: state.latest_authority_status,
      }, policy);
      maybeAppendPrimeEntry(pi, 'agoragentic.agent', recorded);
    });

    pi.on('tool_call', async (event = {}, ctx = {}) => {
      const classification = classifyPrimeToolCall(event);
      const authorityBinding = buildAuthorityBinding(event, {
        principal_ref: state.principal_ref,
        agent_ref: state.agent_ref,
        session_ref: state.session_id,
      });
      const principalRequired = new Set([
        ...HIGH_IMPACT_SIDE_EFFECT_CLASSES,
        ...(policy.require_principal_authority_for || []),
      ]);
      let authority = state.authority;
      if (principalRequired.has(classification.side_effect_class) && typeof options.resolveAuthority === 'function') {
        try {
          authority = await options.resolveAuthority(Object.freeze({
            event,
            classification,
            binding: authorityBinding,
          }));
        } catch {
          authority = null;
        }
      }
      const decision = evaluatePrimeToolCall(event, {
        authority,
        principal_ref: state.principal_ref,
        agent_ref: state.agent_ref,
        session_ref: state.session_id,
        verifyAuthority: options.verifyAuthority,
        isAuthorityConsumed: (authorityId, binding) => (
          state.consumed_authority_ids.has(authorityId)
          || state.consumed_action_hashes.has(binding.action_hash)
        ),
      }, policy);
      state.latest_policy_decision = decision;
      state.latest_authority_id = decision.authority_validation?.authority_id || null;
      state.latest_authority_status = decision.authority_validation
        ? (decision.authority_validation.valid ? 'verified' : 'invalid')
        : (authority ? 'unverified' : 'missing');
      if (decision.authority_validation?.valid) {
        state.consumed_authority_ids.add(decision.authority_validation.authority_id);
        state.consumed_action_hashes.add(decision.authority_binding.action_hash);
      }
      const recorded = appendBoundedEvent(state, {
        type: 'tool_policy_decision',
        tool_name: decision.classification.tool_name,
        capability: decision.classification.capability,
        side_effect_class: decision.classification.side_effect_class,
        input_hash: decision.classification.input_hash,
        decision: decision.decision,
        reason: decision.reason,
        action_hash: decision.authority_binding?.action_hash || null,
        authority_id: state.latest_authority_id,
        authority_status: state.latest_authority_status,
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
        reason: event.type === 'agent_end' ? 'agent_end' : 'unknown',
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
            authority_status: state.latest_authority_status,
            authority_id: state.latest_authority_id,
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
                session_id: state.session_id,
                authority_status: state.latest_authority_status,
                authority_id: state.latest_authority_id,
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
