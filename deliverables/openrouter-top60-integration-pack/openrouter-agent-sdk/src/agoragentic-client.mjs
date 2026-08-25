const DEFAULT_BASE_URL = 'https://agoragentic.com';
const DEFAULT_TIMEOUT_MS = 30_000;

export class AgoragenticOpenRouterError extends Error {
  constructor({
    code,
    message,
    status = 0,
    retryable = false,
    outcomeUnknown = false,
    reconciliationRequired = false,
    details = null,
    cause,
  }) {
    super(message, { cause });
    this.name = 'AgoragenticOpenRouterError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.outcomeUnknown = outcomeUnknown;
    this.reconciliationRequired = reconciliationRequired;
    this.details = details;
  }
}

function assertText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgoragenticOpenRouterError({ code: 'invalid_input', message: `${name} must be a non-empty string`, status: 400 });
  }
  return value.trim();
}

function assertRecord(value, name) {
  const prototype = value && typeof value === 'object' ? Object.getPrototypeOf(value) : undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || (prototype !== Object.prototype && prototype !== null)) {
    throw new AgoragenticOpenRouterError({ code: 'invalid_input', message: `${name} must be a plain object`, status: 400 });
  }
  return { ...value };
}

function assertNonnegativeFiniteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new AgoragenticOpenRouterError({ code: 'invalid_input', message: `${name} must be a finite non-negative number`, status: 400 });
  }
  return value;
}

function assertNonnegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new AgoragenticOpenRouterError({ code: 'invalid_input', message: `${name} must be a non-negative integer`, status: 400 });
  }
  return value;
}

function combineSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`request timed out after ${timeoutMs}ms`)), timeoutMs);
  const onAbort = () => controller.abort(signal.reason || new Error('request aborted'));
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    },
  };
}

export class AgoragenticClient {
  constructor({
    baseUrl = process.env.AGORAGENTIC_BASE_URL || DEFAULT_BASE_URL,
    apiKey = process.env.AGORAGENTIC_API_KEY || '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl = globalThis.fetch,
  } = {}) {
    if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
      throw new Error('AGORAGENTIC_BASE_URL must use HTTPS unless it is loopback');
    }
    this.baseUrl = parsed;
    this.apiKey = apiKey;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be a positive finite number');
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  requireApiKey() {
    if (!this.apiKey) {
      throw new AgoragenticOpenRouterError({ code: 'missing_api_key', message: 'AGORAGENTIC_API_KEY is required', status: 401 });
    }
  }

  async request(path, { method = 'GET', body, signal, auth = true } = {}) {
    if (auth) this.requireApiKey();
    const isPaidExecution = method === 'POST' && path === '/api/execute';
    const bound = combineSignal(signal, this.timeoutMs);
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), {
        method,
        signal: bound.signal,
        headers: {
          Accept: 'application/json',
          ...(auth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = { message: text.slice(0, 1_000) }; }
      }
      if (!response.ok) {
        throw new AgoragenticOpenRouterError({
          code: payload?.error?.code || payload?.code || 'agoragentic_request_failed',
          message: payload?.error?.message || payload?.message || `Agoragentic request failed with HTTP ${response.status}`,
          status: response.status,
          retryable: !isPaidExecution && (response.status === 429 || response.status >= 500),
          outcomeUnknown: isPaidExecution && response.status >= 500,
          reconciliationRequired: isPaidExecution && response.status >= 500,
          details: payload,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof AgoragenticOpenRouterError) throw error;
      const timedOut = bound.signal.aborted;
      if (isPaidExecution) {
        throw new AgoragenticOpenRouterError({
          code: 'execute_outcome_unknown',
          message: 'Agoragentic execution outcome is unknown; do not retry automatically',
          retryable: false,
          outcomeUnknown: true,
          reconciliationRequired: true,
          details: {
            safe_next_action: 'Reconcile platform activity or receipts with an operator before starting another execution.',
          },
          cause: error,
        });
      }
      throw new AgoragenticOpenRouterError({
        code: timedOut ? 'request_aborted_or_timed_out' : 'network_error',
        message: timedOut ? 'Agoragentic request was aborted or timed out' : 'Agoragentic network request failed',
        retryable: true,
        cause: error,
      });
    } finally {
      bound.cleanup();
    }
  }

  match({ task, constraints = {}, signal } = {}) {
    const params = new URLSearchParams({ task: assertText(task, 'task') });
    const normalized = assertRecord(constraints, 'constraints');
    if (normalized.category !== undefined) params.set('category', assertText(normalized.category, 'constraints.category'));
    if (normalized.max_cost !== undefined) params.set('max_cost', String(assertNonnegativeFiniteNumber(normalized.max_cost, 'constraints.max_cost')));
    if (normalized.max_latency_ms !== undefined) params.set('max_latency_ms', String(assertNonnegativeInteger(normalized.max_latency_ms, 'constraints.max_latency_ms')));
    if (normalized.payment_network !== undefined) params.set('payment_network', assertText(normalized.payment_network, 'constraints.payment_network'));
    return this.request(`/api/execute/match?${params}`, { signal });
  }

  quote({ task, constraints = {}, signal } = {}) {
    return this.match({ task, constraints, signal });
  }

  execute({ task, input = {}, constraints = {}, signal } = {}) {
    const normalized = assertRecord(constraints, 'constraints');
    const normalizedInput = assertRecord(input, 'input');
    const hasMaxCost = Object.hasOwn(normalized, 'max_cost');
    const hasQuoteId = Object.hasOwn(normalized, 'quote_id');
    if (hasMaxCost) normalized.max_cost = assertNonnegativeFiniteNumber(normalized.max_cost, 'constraints.max_cost');
    if (hasQuoteId) normalized.quote_id = assertText(normalized.quote_id, 'constraints.quote_id');
    if (!hasMaxCost && !hasQuoteId) {
      throw new AgoragenticOpenRouterError({
        code: 'missing_execution_bound',
        message: 'constraints.max_cost or constraints.quote_id is required before execution',
        status: 400,
      });
    }
    const quoteId = hasQuoteId ? normalized.quote_id : undefined;
    if (hasQuoteId) delete normalized.quote_id;
    const body = { task: assertText(task, 'task'), input: normalizedInput, constraints: normalized };
    if (hasQuoteId) body.quote_id = quoteId;
    return this.request('/api/execute', { method: 'POST', body, signal });
  }

  status({ invocationId, signal } = {}) {
    return this.request(`/api/execute/status/${encodeURIComponent(assertText(invocationId, 'invocationId'))}`, { signal });
  }

  receipt({ invocationId, signal } = {}) {
    return this.request(`/api/commerce/receipts/${encodeURIComponent(assertText(invocationId, 'invocationId'))}`, { signal });
  }
}
