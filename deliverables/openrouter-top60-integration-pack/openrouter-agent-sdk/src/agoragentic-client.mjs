const DEFAULT_BASE_URL = 'https://agoragentic.com';
const DEFAULT_TIMEOUT_MS = 30_000;

export class AgoragenticOpenRouterError extends Error {
  constructor({ code, message, status = 0, retryable = false, details = null, cause }) {
    super(message, { cause });
    this.name = 'AgoragenticOpenRouterError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function assertText(value, name) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgoragenticOpenRouterError({ code: 'invalid_input', message: `${name} must be a non-empty string`, status: 400 });
  }
  return value.trim();
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
          retryable: response.status === 429 || response.status >= 500,
          details: payload,
        });
      }
      return payload;
    } catch (error) {
      if (error instanceof AgoragenticOpenRouterError) throw error;
      const timedOut = bound.signal.aborted;
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
    if (constraints.max_cost !== undefined) params.set('max_cost', String(constraints.max_cost));
    if (constraints.min_trust !== undefined) params.set('min_trust', String(constraints.min_trust));
    return this.request(`/api/execute/match?${params}`, { signal });
  }

  quote({ task, input = {}, constraints = {}, signal } = {}) {
    return this.request('/api/execute/quote', { method: 'POST', body: { task: assertText(task, 'task'), input, constraints }, signal });
  }

  execute({ task, input = {}, constraints = {}, signal } = {}) {
    return this.request('/api/execute', { method: 'POST', body: { task: assertText(task, 'task'), input, constraints }, signal });
  }

  status({ invocationId, signal } = {}) {
    return this.request(`/api/execute/status/${encodeURIComponent(assertText(invocationId, 'invocationId'))}`, { signal });
  }

  receipt({ invocationId, signal } = {}) {
    return this.request(`/api/execute/receipt/${encodeURIComponent(assertText(invocationId, 'invocationId'))}`, { signal });
  }
}
