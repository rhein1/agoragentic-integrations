import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const GUARD_SCHEMA = 'agoragentic.guard.policy.v1';
export const ACTION_SCHEMA = 'agoragentic.guard.action.v1';
export const DECISION_SCHEMA = 'agoragentic.guard.decision.v1';
export const RECEIPT_SCHEMA = 'agoragentic.guard.receipt.v1';

const SIDE_EFFECT_ACTIONS = new Set([
  'wallet_transfer',
  'token_approval',
  'swap',
  'contract_call',
  'x402_purchase',
  'marketplace_execute',
  'credential_mutation',
  'public_exposure_change',
]);

const WALLET_OR_CONTRACT_ACTIONS = new Set(['wallet_transfer', 'token_approval', 'swap', 'contract_call']);

const PROMPT_INJECTION_PATTERNS = [
  ['ignore_previous_instructions', 'critical', /\bignore (all )?(previous|prior) instructions\b/i],
  ['policy_bypass_request', 'critical', /\b(bypass|disable|override).{0,60}\b(policy|approval|guardrail|budget|safety)\b/i],
  ['unauthorized_spend_request', 'critical', /\b(transfer|spend|withdraw|pay).{0,80}\b(automatically|silently|without approval|without review)\b/i],
  ['secret_exfiltration_request', 'critical', /\b(seed phrase|private key|api key|bearer token|wallet secret|mnemonic)\b/i],
  ['system_prompt_exfiltration_request', 'high', /\b(system prompt|developer message|hidden instruction)\b/i],
  ['encoded_instruction_reference', 'high', /\b(morse|base64|hex|rot13|zero[- ]?width|unicode tag)\b/i],
];

export const DEFAULT_GUARD_POLICY = Object.freeze({
  schema: GUARD_SCHEMA,
  mode: 'local_preflight_no_spend',
  owner: {
    owner_id: 'local_owner',
    require_explicit_owner_review: true,
  },
  agent: {
    agent_id: 'agent_demo',
    agent_name: 'Demo Agent',
    deployment_id: null,
  },
  scope: {
    allowed_chains: ['base'],
    allowed_assets: ['USDC'],
    allowed_action_types: [
      'x402_purchase',
      'marketplace_execute',
      'wallet_transfer',
      'token_approval',
      'contract_call',
      'swap',
      'credential_mutation',
      'public_exposure_change',
    ],
    blocked_action_types: [],
  },
  spend_limits: {
    max_single_action_usdc: 5,
    max_daily_usdc: 20,
    approval_required_above_usdc: 1,
    deny_token_approvals_by_default: true,
    max_token_approval_usdc: 0,
    allow_unlimited_approval: false,
  },
  counterparty_policy: {
    allowed_recipients: [],
    blocked_recipients: [],
    allow_first_time_recipient_without_review: false,
    require_recipient_label: true,
  },
  source_boundary: {
    external_content_is_data_not_instruction: true,
    block_encoded_instruction_sources: true,
    block_decoded_text_as_authority: true,
    suspicious_encodings: ['morse', 'base64', 'hex', 'rot13', 'unicode_tags', 'zero_width'],
    untrusted_source_types: [
      'social_post',
      'reply',
      'dm',
      'nft_metadata',
      'token_metadata',
      'website',
      'retrieved_document',
      'tool_description',
      'openapi_description',
      'marketplace_listing',
      'ocr_text',
      'translated_text',
      'decoded_text',
    ],
  },
  approval_policy: {
    human_gated: [
      'wallet_transfer',
      'token_approval',
      'swap',
      'contract_call',
      'credential_mutation',
      'public_exposure_change',
    ],
    supervisor_required_for: [
      'first_time_recipient',
      'encoded_instruction_detected',
      'approval_escalation',
      'policy_mutation',
      'daily_limit_exceeded',
      'unusual_asset',
      'untrusted_instruction_source',
    ],
  },
  receipt_policy: {
    write_local_receipts: true,
    require_intent_outcome_reconciliation: true,
    include_source_fingerprint: true,
    include_policy_snapshot: true,
  },
  agent_os: {
    use_public_procurement_check_when_configured: true,
    base_url_env: 'AGORAGENTIC_BASE_URL',
    api_key_env: 'AGORAGENTIC_API_KEY',
    procurement_check_path: '/api/commerce/procurement/check',
    execute_path: '/api/execute',
    receipts_path: '/api/commerce/receipts',
  },
  future_onchain_enforcement: {
    erc_7579_compatible: true,
    safe_module_compatible: true,
    session_key_compatible: true,
    module_generation_enabled: false,
  },
});

export function validateGuardPolicy(policy = {}) {
  const errors = [];
  if (!isObject(policy)) return { ok: false, errors: ['policy must be an object'], policy: null };
  if (policy.schema !== GUARD_SCHEMA) errors.push(`schema must be ${GUARD_SCHEMA}`);
  if (policy.mode !== 'local_preflight_no_spend') errors.push('mode must be local_preflight_no_spend');
  requireBoolean(errors, policy.owner?.require_explicit_owner_review, true, 'owner.require_explicit_owner_review');
  requireString(errors, policy.owner?.owner_id, 'owner.owner_id');
  requireString(errors, policy.agent?.agent_id, 'agent.agent_id');
  requireStringArray(errors, policy.scope?.allowed_chains, 'scope.allowed_chains');
  requireStringArray(errors, policy.scope?.allowed_assets, 'scope.allowed_assets');
  requireStringArray(errors, policy.scope?.allowed_action_types, 'scope.allowed_action_types');
  requireNumber(errors, policy.spend_limits?.max_single_action_usdc, 'spend_limits.max_single_action_usdc');
  requireNumber(errors, policy.spend_limits?.max_daily_usdc, 'spend_limits.max_daily_usdc');
  requireNumber(errors, policy.spend_limits?.approval_required_above_usdc, 'spend_limits.approval_required_above_usdc');
  requireBoolean(errors, policy.spend_limits?.deny_token_approvals_by_default, undefined, 'spend_limits.deny_token_approvals_by_default');
  requireBoolean(errors, policy.spend_limits?.allow_unlimited_approval, false, 'spend_limits.allow_unlimited_approval');
  requireBoolean(errors, policy.counterparty_policy?.allow_first_time_recipient_without_review, undefined, 'counterparty_policy.allow_first_time_recipient_without_review');
  requireBoolean(errors, policy.counterparty_policy?.require_recipient_label, undefined, 'counterparty_policy.require_recipient_label');
  requireBoolean(errors, policy.source_boundary?.external_content_is_data_not_instruction, true, 'source_boundary.external_content_is_data_not_instruction');
  requireBoolean(errors, policy.source_boundary?.block_encoded_instruction_sources, true, 'source_boundary.block_encoded_instruction_sources');
  requireBoolean(errors, policy.source_boundary?.block_decoded_text_as_authority, true, 'source_boundary.block_decoded_text_as_authority');
  requireStringArray(errors, policy.source_boundary?.untrusted_source_types, 'source_boundary.untrusted_source_types');
  requireStringArray(errors, policy.approval_policy?.human_gated, 'approval_policy.human_gated');
  requireBoolean(errors, policy.receipt_policy?.write_local_receipts, true, 'receipt_policy.write_local_receipts');
  requireBoolean(errors, policy.receipt_policy?.require_intent_outcome_reconciliation, true, 'receipt_policy.require_intent_outcome_reconciliation');
  requireBoolean(errors, policy.agent_os?.use_public_procurement_check_when_configured, undefined, 'agent_os.use_public_procurement_check_when_configured');
  if (policy.future_onchain_enforcement?.module_generation_enabled !== false) {
    errors.push('future_onchain_enforcement.module_generation_enabled must be false in public V1');
  }
  return { ok: errors.length === 0, errors, policy };
}

export function validateGuardAction(action = {}) {
  const errors = [];
  if (!isObject(action)) return { ok: false, errors: ['action must be an object'], action: null };
  if (action.schema !== ACTION_SCHEMA) errors.push(`schema must be ${ACTION_SCHEMA}`);
  requireString(errors, action.action_id, 'action.action_id');
  requireString(errors, action.agent?.agent_id, 'action.agent.agent_id');
  requireString(errors, action.action_type, 'action.action_type');
  requireString(errors, action.chain, 'action.chain');
  requireString(errors, action.asset, 'action.asset');
  requireNumber(errors, action.amount_usdc, 'action.amount_usdc');
  if (action.contract?.is_unlimited_approval !== undefined && typeof action.contract.is_unlimited_approval !== 'boolean') {
    errors.push('contract.is_unlimited_approval must be boolean when present');
  }
  if (!isObject(action.intent)) errors.push('intent must be an object');
  if (!isObject(action.source_context)) errors.push('source_context must be an object');
  return { ok: errors.length === 0, errors, action };
}

export function evaluateGuardAction(policyInput, actionInput, options = {}) {
  const policy = policyInput || DEFAULT_GUARD_POLICY;
  const policyValidation = validateGuardPolicy(policy);
  const actionValidation = validateGuardAction(actionInput);
  const createdAt = options.created_at || new Date().toISOString();
  const actionId = actionInput?.action_id || 'invalid_action';
  const reasons = [];
  const requiredApprovals = new Set();

  const addReason = (code, severity, message, approvalCode = code) => {
    reasons.push({ code, severity, message });
    if (severity === 'approval' || severity === 'medium' || severity === 'high') requiredApprovals.add(approvalCode);
  };

  if (!policyValidation.ok) {
    for (const error of policyValidation.errors) addReason('invalid_policy', 'critical', error);
  }
  if (!actionValidation.ok) {
    for (const error of actionValidation.errors) addReason('invalid_action', 'critical', error);
  }

  const action = actionValidation.ok ? actionInput : {};
  const amount = Number(action.amount_usdc || 0);
  const actionType = action.action_type;
  const sideEffect = SIDE_EFFECT_ACTIONS.has(actionType);
  const sourceScan = scanSourceText(action.source_context?.source_text || '');
  const sourceType = String(action.source_context?.source_type || 'unknown');
  const decodedFrom = action.source_context?.decoded_from;
  const encodedSignal = sourceScan.detected_encodings.length > 0 || Boolean(decodedFrom);

  if (policyValidation.ok && actionValidation.ok) {
    if (!policy.scope.allowed_action_types.includes(actionType)) {
      addReason('action_type_not_allowed', 'critical', `${actionType} is not allowed by guard scope.`);
    }
    if ((policy.scope.blocked_action_types || []).includes(actionType)) {
      addReason('action_type_blocked', 'critical', `${actionType} is explicitly blocked.`);
    }
    if (!policy.scope.allowed_chains.includes(action.chain)) {
      addReason('chain_not_allowed', 'critical', `${action.chain} is not in allowed_chains.`);
    }
    if (!policy.scope.allowed_assets.includes(action.asset)) {
      addReason('asset_not_allowed', 'high', `${action.asset} is not in allowed_assets.`, 'unusual_asset');
    }
    if (amount > Number(policy.spend_limits.max_daily_usdc)) {
      addReason('daily_limit_exceeded', 'critical', `amount_usdc ${amount} exceeds max_daily_usdc.`, 'daily_limit_exceeded');
    }
    if (amount > Number(policy.spend_limits.max_single_action_usdc)) {
      addReason('single_action_limit_exceeded', 'critical', `amount_usdc ${amount} exceeds max_single_action_usdc.`, 'approval_escalation');
    }
    if (amount > Number(policy.spend_limits.approval_required_above_usdc)) {
      addReason('approval_threshold_exceeded', 'approval', `amount_usdc ${amount} exceeds approval threshold.`, 'approval_escalation');
    }
    if (actionType === 'token_approval' && policy.spend_limits.deny_token_approvals_by_default === true) {
      addReason('token_approval_blocked_by_default', 'critical', 'token approvals are denied by default.');
    }
    if (actionType === 'token_approval' && action.contract?.is_unlimited_approval === true && policy.spend_limits.allow_unlimited_approval !== true) {
      addReason('unlimited_token_approval_blocked', 'critical', 'unlimited token approvals are denied.');
    }
    const approvalAmount = Number(action.contract?.approval_amount_usdc || 0);
    if (actionType === 'token_approval' && approvalAmount > Number(policy.spend_limits.max_token_approval_usdc || 0)) {
      addReason('token_approval_amount_exceeded', 'critical', 'token approval amount exceeds max_token_approval_usdc.');
    }

    evaluateCounterparty(policy, action, addReason);
    evaluateSourceBoundary(policy, action, sourceScan, encodedSignal, sourceType, sideEffect, addReason);

    if ((policy.approval_policy.human_gated || []).includes(actionType)) {
      addReason('human_gate_required', 'approval', `${actionType} requires human review.`, actionType);
    }
    if (actionType === 'credential_mutation') addReason('credential_mutation_requires_approval', 'approval', 'credential mutations require owner approval.', actionType);
    if (actionType === 'public_exposure_change') addReason('public_exposure_change_requires_approval', 'approval', 'public exposure changes require owner approval.', actionType);
  }

  for (const finding of sourceScan.findings) {
    addReason(finding.code, finding.severity, finding.message, finding.code);
  }

  const critical = reasons.some((reason) => reason.severity === 'critical');
  const approval = reasons.some((reason) => ['approval', 'medium', 'high'].includes(reason.severity));
  const verdict = critical ? 'deny' : approval ? 'needs_approval' : 'allow';
  const riskScore = Math.min(100, reasons.reduce((score, reason) => score + severityScore(reason.severity), 0));
  const riskLevel = riskScore >= 80 ? 'critical' : riskScore >= 50 ? 'high' : riskScore >= 20 ? 'medium' : 'low';
  const safeToExecute = verdict === 'allow';
  const policySnapshotHash = stableHash(policy);
  const actionFingerprint = stableHash(actionInput || {});

  return {
    schema: DECISION_SCHEMA,
    decision_id: stableId('guard_decision', `${policySnapshotHash}:${actionFingerprint}:${actionId}`),
    created_at: createdAt,
    action_id: actionId,
    verdict,
    risk_level: riskLevel,
    risk_score: riskScore,
    reasons,
    source_scan: sourceScan,
    matched_controls: {
      spend_limit: true,
      source_boundary: true,
      counterparty_policy: true,
      approval_policy: true,
      receipt_policy: true,
    },
    required_approvals: [...requiredApprovals],
    safe_to_execute: safeToExecute,
    agent_os_next_step: nextStepFor(policy, action, verdict),
    receipt_required: policy.receipt_policy?.write_local_receipts !== false,
    policy_snapshot_hash: policySnapshotHash,
    action_fingerprint: actionFingerprint,
    agent_os: {
      procurement_check_attempted: false,
      execute_attempted: false,
      procurement_check: null,
    },
  };
}

export function scanSourceText(text = '') {
  const value = String(text || '');
  const findings = [];
  const detectedEncodings = [];
  const checks = [
    ['morse', detectMorseLike],
    ['base64', detectBase64Like],
    ['hex', detectHexLike],
    ['rot13', detectRot13Hint],
    ['zero_width', detectZeroWidth],
    ['unicode_tags', detectUnicodeTags],
  ];
  for (const [encoding, detector] of checks) {
    if (detector(value)) detectedEncodings.push(encoding);
  }
  if (detectedEncodings.length) {
    findings.push({
      code: 'encoded_instruction_detected',
      severity: 'critical',
      message: `Suspicious encoded-text signal detected: ${detectedEncodings.join(', ')}.`,
    });
  }
  for (const [code, severity, pattern] of PROMPT_INJECTION_PATTERNS) {
    if (pattern.test(value)) findings.push({ code, severity, message: `Source text matched ${code}.` });
  }
  return {
    schema: 'agoragentic.guard.source-scan.v1',
    detected_encodings: detectedEncodings,
    findings,
    external_content_is_data_not_instruction: true,
    decoded_text_used_as_authority: false,
  };
}

export function detectMorseLike(text = '') {
  const value = String(text).replace(/[A-Za-z]*morse[A-Za-z]*/gi, '').trim();
  if (!value || !/^[.\-\s/]+$/.test(value)) return false;
  const tokens = value.split(/[\s/]+/).filter(Boolean);
  return tokens.length >= 3
    && tokens.every((token) => /^[.-]{1,6}$/.test(token))
    && tokens.some((token) => token.includes('.'))
    && tokens.some((token) => token.includes('-'));
}

export function detectBase64Like(text = '') {
  return /(?:^|[^A-Za-z0-9+/=])(?:[A-Za-z0-9+/]{24,}={0,2})(?:$|[^A-Za-z0-9+/=])/.test(String(text));
}

export function detectHexLike(text = '') {
  return /\b(?:0x)?[a-fA-F0-9]{32,}\b/.test(String(text));
}

export function detectRot13Hint(text = '') {
  return /\brot13\b/i.test(String(text));
}

export function detectZeroWidth(text = '') {
  return /[\u200B-\u200D\uFEFF]/u.test(String(text));
}

export function detectUnicodeTags(text = '') {
  return /[\u{E0000}-\u{E007F}]/u.test(String(text));
}

export const trapScan = scanSourceText;

export function createGuardReceipt(policy, action, decision, options = {}) {
  const createdAt = options.created_at || new Date().toISOString();
  const sourceText = action?.source_context?.source_text || '';
  const status = decision.verdict === 'allow' ? 'allowed' : decision.verdict === 'needs_approval' ? 'approval_required' : 'blocked';
  return {
    schema: RECEIPT_SCHEMA,
    receipt_id: stableId('guard_receipt', `${decision.decision_id}:${decision.action_fingerprint}`),
    created_at: createdAt,
    mode: 'local_preflight_no_spend',
    status,
    action_id: action.action_id,
    decision_id: decision.decision_id,
    agent: action.agent || {},
    intent: action.intent || {},
    decision: {
      verdict: decision.verdict,
      risk_level: decision.risk_level,
      risk_score: decision.risk_score,
      reasons: decision.reasons,
    },
    spend: {
      amount_usdc: Number(action.amount_usdc || 0),
      asset: action.asset || null,
      chain: action.chain || null,
      settlement_status: 'not_attempted',
    },
    source_boundary: {
      source_type: action.source_context?.source_type || null,
      source_fingerprint: sourceText ? stableHash(sourceText) : null,
      external_content_is_data_not_instruction: true,
      decoded_text_used_as_authority: false,
    },
    policy: {
      schema: policy.schema,
      snapshot_hash: decision.policy_snapshot_hash,
    },
    agent_os: {
      procurement_check_attempted: Boolean(decision.agent_os?.procurement_check_attempted),
      execute_attempted: false,
      hosted_receipt_id: null,
    },
    reconciliation: {
      intended_outcome: action.intent?.expected_outcome || null,
      actual_outcome: null,
      matched: null,
      requires_post_action_review: decision.verdict !== 'allow',
    },
    public_boundary: {
      no_private_full_ecf_internals: true,
      no_wallet_secret_material: true,
      no_settlement_executor: true,
    },
  };
}

export async function writeGuardReceipt(dir, receipt) {
  const root = path.resolve(dir || process.cwd());
  const receiptDir = path.join(root, '.agoragentic', 'guard-receipts');
  await fs.mkdir(receiptDir, { recursive: true });
  const receiptPath = path.join(receiptDir, `${receipt.receipt_id}.json`);
  await fs.writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  await fs.appendFile(path.join(receiptDir, 'index.jsonl'), `${JSON.stringify({
    receipt_id: receipt.receipt_id,
    action_id: receipt.action_id,
    decision_id: receipt.decision_id,
    status: receipt.status,
    created_at: receipt.created_at,
    receipt_path: receiptPath,
  })}\n`, 'utf8');
  return receiptPath;
}

export async function maybeRunAgentOsProcurementCheck(policy, action, decision, options = {}) {
  if (policy?.agent_os?.use_public_procurement_check_when_configured !== true) return { ...decision };
  if (!['marketplace_execute', 'x402_purchase'].includes(action?.action_type)) return { ...decision };
  if (decision.verdict === 'deny') return { ...decision };

  const env = options.env || process.env;
  const baseUrl = options.base_url || env[policy.agent_os.base_url_env || 'AGORAGENTIC_BASE_URL'];
  const apiKey = options.api_key || env[policy.agent_os.api_key_env || 'AGORAGENTIC_API_KEY'];
  if (!baseUrl || !apiKey) {
    return {
      ...decision,
      agent_os_next_step: decision.verdict === 'allow' ? 'procurement_check' : 'request_approval',
      agent_os: {
        ...(decision.agent_os || {}),
        procurement_check_attempted: false,
        procurement_check: { status: 'skipped', reason: 'agent_os_env_not_configured' },
      },
    };
  }

  const fetchImpl = options.fetch || globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    return {
      ...decision,
      agent_os: {
        ...(decision.agent_os || {}),
        procurement_check_attempted: false,
        procurement_check: { status: 'skipped', reason: 'fetch_unavailable' },
      },
    };
  }

  const url = new URL(policy.agent_os.procurement_check_path || '/api/commerce/procurement/check', baseUrl);
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      action_id: action.action_id,
      action_type: action.action_type,
      amount_usdc: action.amount_usdc,
      asset: action.asset,
      chain: action.chain,
      quote_id: action.intent?.quote_id || null,
      capability_id: action.intent?.capability_id || null,
      guard_decision_id: decision.decision_id,
    }),
  });
  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { text: text.slice(0, 240) };
    }
  }
  return {
    ...decision,
    agent_os_next_step: decision.verdict === 'allow' ? 'procurement_check' : 'request_approval',
    agent_os: {
      ...(decision.agent_os || {}),
      procurement_check_attempted: true,
      execute_attempted: false,
      procurement_check: {
        status: response.ok ? 'recorded' : 'failed',
        http_status: response.status,
        summary: payload,
      },
    },
  };
}

export function stableHash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function stableId(prefix, value) {
  return `${prefix}_${stableHash(value).slice(7, 19)}`;
}

function evaluateCounterparty(policy, action, addReason) {
  if (!WALLET_OR_CONTRACT_ACTIONS.has(action.action_type)) return;
  const recipient = action.recipient || {};
  const recipientToken = normalizeRecipient(recipient.address || recipient.label || action.contract?.address || action.contract?.spender || '');
  const blocked = (policy.counterparty_policy.blocked_recipients || []).map(normalizeRecipient);
  const allowed = (policy.counterparty_policy.allowed_recipients || []).map((entry) => normalizeRecipient(isObject(entry) ? entry.address || entry.label : entry));
  if (recipientToken && blocked.includes(recipientToken)) addReason('blocked_recipient', 'critical', 'recipient is blocked by policy.');
  const allowlisted = recipientToken && allowed.includes(recipientToken);
  if (recipient.first_seen === true && !policy.counterparty_policy.allow_first_time_recipient_without_review && !allowlisted) {
    addReason('first_time_recipient_requires_review', 'approval', 'first-time recipient requires review.', 'first_time_recipient');
  }
  if (policy.counterparty_policy.require_recipient_label && !recipient.label) {
    addReason('recipient_label_required', 'approval', 'recipient label is required.', 'first_time_recipient');
  }
  if (allowed.length > 0 && !allowlisted) addReason('recipient_not_allowlisted', 'approval', 'recipient is not allowlisted.', 'first_time_recipient');
}

function evaluateSourceBoundary(policy, action, scan, encodedSignal, sourceType, sideEffect, addReason) {
  if (!sideEffect) return;
  if (policy.source_boundary.block_encoded_instruction_sources && encodedSignal) {
    addReason('encoded_instruction_detected', 'critical', 'encoded or decoded source content cannot authorize side effects.', 'encoded_instruction_detected');
  }
  if (policy.source_boundary.block_decoded_text_as_authority && (sourceType === 'decoded_text' || action.source_context?.decoded_from)) {
    addReason('decoded_text_as_authority', 'critical', 'decoded text is data, not authority.', 'encoded_instruction_detected');
  }
  if ((policy.source_boundary.untrusted_source_types || []).includes(sourceType) && action.source_context?.contains_external_instruction === true) {
    addReason('untrusted_instruction_source', 'critical', `${sourceType} contains external instruction-like content.`, 'untrusted_instruction_source');
  }
  if (scan.findings.some((finding) => finding.severity === 'critical')) {
    addReason('trap_scan_critical', 'critical', 'source text contains critical prompt-injection indicators.', 'untrusted_instruction_source');
  }
}

function nextStepFor(policy, action, verdict) {
  if (verdict === 'deny') return 'skip';
  if (verdict === 'needs_approval') return 'request_approval';
  if (['marketplace_execute', 'x402_purchase'].includes(action?.action_type) && policy.agent_os?.use_public_procurement_check_when_configured) {
    return 'procurement_check';
  }
  if (WALLET_OR_CONTRACT_ACTIONS.has(action?.action_type)) return 'request_approval';
  return 'execute';
}

function severityScore(severity) {
  if (severity === 'critical') return 80;
  if (severity === 'high') return 50;
  if (severity === 'medium') return 25;
  if (severity === 'approval') return 20;
  return 5;
}

function requireString(errors, value, field) {
  if (typeof value !== 'string' || !value.trim()) errors.push(`${field} is required`);
}

function requireStringArray(errors, value, field) {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string')) errors.push(`${field} must be an array of strings`);
}

function requireNumber(errors, value, field) {
  if (!Number.isFinite(Number(value))) errors.push(`${field} must be a number`);
}

function requireBoolean(errors, value, expected, field) {
  if (typeof value !== 'boolean') errors.push(`${field} must be boolean`);
  else if (expected !== undefined && value !== expected) errors.push(`${field} must be ${expected}`);
}

function normalizeRecipient(value) {
  return String(value || '').trim().toLowerCase();
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
