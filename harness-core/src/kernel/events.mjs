import crypto from 'node:crypto';

export const EVENT_SCHEMA = 'agoragentic.harness.event.v1';

export const EVENT_TYPES = Object.freeze([
  'before_agent',
  'after_agent',
  'before_policy',
  'after_policy',
  'before_tool',
  'after_tool',
  'before_receipt',
  'after_receipt',
  'before_export',
  'after_export',
  'approval_required',
  'guard_decision',
  'artifact_written',
  'run_completed',
  'run_blocked',
]);

export const EVENT_SEVERITIES = Object.freeze(['info', 'warning', 'blocked', 'error']);

const SENSITIVE_KEY_PATTERN = /\b(raw[_-]?(prompt|output|tool|sqlite|ecf)|prompt|system[_-]?prompt|tool[_-]?output|secret|token|bearer|authorization|api[_-]?key|private[_-]?key|seed[_-]?phrase|mnemonic|password|wallet[_-]?private|payment[_-]?payload|private[_-]?ecf|database[_-]?url|cookie|credential)\b/i;
const SECRET_TEXT_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]'],
  [/\bamk_[A-Za-z0-9._-]{8,}/gi, 'amk_[REDACTED]'],
  [/\bsk-[A-Za-z0-9._-]{8,}/gi, 'sk-[REDACTED]'],
  [/\b[A-Z0-9_]*(SECRET|TOKEN|API_KEY|PRIVATE_KEY|DATABASE_URL)[A-Z0-9_]*\b/g, '[REDACTED_SECRET_NAME]'],
  [/\b[A-Za-z0-9+/=]{40,}\b/g, '[REDACTED_LONG_TOKEN]'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
];

export function authorityBoundary(extra = {}) {
  return {
    mode: 'local_no_spend',
    wallet_spend: false,
    wallet_mutation: false,
    deploy_runtime: false,
    hosted_runtime_provisioning: false,
    marketplace_publication: false,
    x402_settlement: false,
    x402_route_activation: false,
    trust_mutation: false,
    ranking_mutation: false,
    provider_dispatch: false,
    public_execute_mutation: false,
    public_invoke_mutation: false,
    private_ecf_export: false,
    owner_approval_bypass: false,
    process_control: false,
    arbitrary_shell: false,
    ...extra,
  };
}

export function createHarnessEvent({
  run_id,
  type,
  severity = 'info',
  summary,
  data = {},
  created_at,
  sequence,
} = {}) {
  if (!run_id) throw new Error('run_id is required for harness events');
  if (!EVENT_TYPES.includes(type)) throw new Error(`unsupported harness event type: ${type}`);
  if (!EVENT_SEVERITIES.includes(severity)) throw new Error(`unsupported harness event severity: ${severity}`);
  const timestamp = created_at || new Date().toISOString();
  const safeSummary = sanitizeText(summary || type, { maxLength: 240 });
  const event = {
    schema: EVENT_SCHEMA,
    event_id: stableId('event', `${run_id}:${type}:${timestamp}:${sequence ?? ''}:${safeSummary}`),
    run_id,
    type,
    created_at: timestamp,
    severity,
    summary: safeSummary,
    data: sanitizeForPublicEvidence(data),
    authority_boundary: authorityBoundary(),
  };
  if (sequence !== undefined) event.sequence = sequence;
  return event;
}

export function sanitizeForPublicEvidence(value, options = {}) {
  const seen = new WeakSet();
  return sanitizeValue(value, {
    maxDepth: options.maxDepth ?? 8,
    maxArrayLength: options.maxArrayLength ?? 50,
    maxStringLength: options.maxStringLength ?? 480,
    seen,
  });
}

export function sanitizeText(value, options = {}) {
  const maxLength = options.maxLength ?? 480;
  let text = String(value ?? '');
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  if (text.length > maxLength) return `${text.slice(0, maxLength)}...[truncated]`;
  return text;
}

export function looksSensitiveKey(key) {
  return SENSITIVE_KEY_PATTERN.test(String(key || ''));
}

export function stableHash(value) {
  return `sha256:${crypto.createHash('sha256').update(stableStringify(value)).digest('hex')}`;
}

export function stableId(prefix, value) {
  return `${prefix}_${stableHash(value).slice(7, 19)}`;
}

export function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function sanitizeValue(value, context) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return sanitizeText(value, { maxLength: context.maxStringLength });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '[REDACTED_UNSUPPORTED_VALUE]';
  if (context.maxDepth <= 0) return '[REDACTED_MAX_DEPTH]';
  if (context.seen.has(value)) return '[REDACTED_CYCLE]';
  context.seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, context.maxArrayLength).map((entry) => sanitizeValue(entry, {
      ...context,
      maxDepth: context.maxDepth - 1,
    }));
    if (value.length > context.maxArrayLength) items.push(`[truncated ${value.length - context.maxArrayLength} items]`);
    return items;
  }

  const output = {};
  for (const [key, child] of Object.entries(value)) {
    if (looksSensitiveKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizeValue(child, {
      ...context,
      maxDepth: context.maxDepth - 1,
    });
  }
  return output;
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}
