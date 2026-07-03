/**
 * Agoragentic Client for Paperclip Integration
 *
 * Router-first client: prefers execute() for capability discovery + routing.
 * Falls back to match+invoke for approval-gated or provider-pinned workflows.
 *
 * Trust vocabulary: 'verified' | 'reachable' | 'failed' — never collapsed to boolean.
 */

const TRUST_LEVELS = ['verified', 'reachable', 'failed'];

class AgoragenticClient {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - Agoragentic API key (from POST /api/quickstart)
   * @param {string} [options.baseUrl='https://agoragentic.com'] - Base URL
   * @param {number} [options.timeoutMs=30000] - Default request timeout
   * @param {number} [options.maxRetries=2] - Max retries on transient failures
   * @param {number} [options.retryDelayMs=1000] - Delay between retries
   */
  constructor(options = {}) {
    if (!options.apiKey) throw new Error('AgoragenticClient: apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl || 'https://agoragentic.com').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs || 30000;
    this.maxRetries = options.maxRetries ?? 2;
    this.retryDelayMs = options.retryDelayMs || 1000;
  }

  /**
   * Execute a task via Agoragentic's capability router.
   * This is the preferred path: the router finds the best provider automatically.
   *
   * @param {Object} params
   * @param {string} params.task - Task type (e.g. 'summarize', 'translate', 'code_review')
   * @param {*} params.input - Task input payload
   * @param {Object} [params.constraints] - Routing constraints
   * @param {number} [params.constraints.max_cost] - Max cost in USDC
   * @param {string} [params.constraints.category] - Preferred category
   * @param {string[]} [params.constraints.trust_levels] - Required trust levels
   * @returns {Promise<AgoragenticExecuteResult>}
   */
  async executeCapability({ task, input, constraints = {} }) {
    const body = { task, input, constraints };
    const result = await this._request('POST', '/api/execute', body);

    return this._normalizeExecuteResult(result);
  }

  /**
   * Match candidate providers without executing.
   * Use this for approval-gated workflows where a supervisor picks the provider.
   *
   * @param {Object} params
   * @param {string} params.task - Task type
   * @param {*} [params.input] - Optional input for relevance scoring
   * @param {Object} [params.constraints] - Routing constraints
   * @returns {Promise<AgoragenticMatchResult>}
   */
  async matchCapabilities({ task, input, constraints = {} }) {
    const query = new URLSearchParams({
      task,
      ...(constraints.max_cost != null && { max_cost: String(constraints.max_cost) }),
      ...(constraints.category && { category: constraints.category }),
    });
    const result = await this._request('GET', `/api/execute/match?${query}`);

    return {
      candidates: (result.candidates || result.matches || []).map(c => ({
        capability_id: c.id || c.capability_id,
        name: c.name,
        description: c.description,
        category: c.category,
        price: c.price,
        trust_status: c.trust_status || c.sandbox_status || 'unknown',
        seller_name: c.seller_name,
        score: c.score,
        _raw: c,
      })),
      _raw: result,
    };
  }

  /**
   * Invoke a specific capability by ID (stricter commerce path).
   * Use after match + approval, or when the provider is known.
   *
   * @param {Object} params
   * @param {string} params.capabilityId - The capability/listing ID
   * @param {*} params.input - Input payload
   * @param {string} [params.idempotencyKey] - Idempotency key for safe retries
   * @returns {Promise<AgoragenticInvokeResult>}
   */
  async invokeCapability({ capabilityId, input, idempotencyKey }) {
    const headers = {};
    if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;

    const result = await this._request(
      'POST',
      `/api/invoke/${encodeURIComponent(capabilityId)}`,
      { input },
      headers
    );

    return {
      invocation_id: result.invocation_id || result.id,
      output: result.output || result.result,
      status: result.status,
      cost: result.cost,
      latency_ms: result.latency_ms,
      provider: result.provider ? {
        id: result.provider.id,
        name: result.provider.name,
        trust_status: result.provider.trust_status || result.provider.sandbox_status || 'unknown',
      } : null,
      _raw: result,
    };
  }

  /**
   * Check the status of a routed execution.
   *
   * @param {string} executionId - Execution ID from execute()
   * @returns {Promise<Object>}
   */
  async getExecutionStatus(executionId) {
    return this._request('GET', `/api/execute/status/${encodeURIComponent(executionId)}`);
  }

  // ─── Internal ─────────────────────────────────────────

  _normalizeExecuteResult(result) {
    return {
      execution_id: result.execution_id || result.id,
      output: result.output || result.result,
      status: result.status,
      cost: result.cost,
      latency_ms: result.latency_ms,
      provider: result.provider ? {
        id: result.provider.id,
        name: result.provider.name,
        trust_status: result.provider.trust_status || result.provider.sandbox_status || 'unknown',
      } : null,
      candidates_considered: result.candidates_considered,
      routing_reason: result.routing_reason,
      _raw: result,
    };
  }

  async _request(method, path, body, extraHeaders = {}) {
    const url = `${this.baseUrl}${path}`;
    const headers = {
      'Authorization': `Bearer ${this.apiKey}`,
      'User-Agent': 'paperclip-agoragentic-plugin/1.0',
      ...(body && { 'Content-Type': 'application/json' }),
      ...extraHeaders,
    };

    let lastError;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timeout);

        const json = await res.json().catch(() => ({}));

        if (res.ok) return json;

        // Non-retryable errors
        if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 404 || res.status === 422) {
          throw new AgoragenticError(
            json.error || json.message || `HTTP ${res.status}`,
            res.status,
            json
          );
        }

        // Retryable errors (429, 5xx)
        lastError = new AgoragenticError(
          json.error || json.message || `HTTP ${res.status}`,
          res.status,
          json
        );
      } catch (err) {
        if (err instanceof AgoragenticError && !err.retryable) throw err;
        lastError = err;
      }

      if (attempt < this.maxRetries) {
        await new Promise(r => setTimeout(r, this.retryDelayMs * (attempt + 1)));
      }
    }
    throw lastError;
  }
}

class AgoragenticError extends Error {
  constructor(message, statusCode, body) {
    super(message);
    this.name = 'AgoragenticError';
    this.statusCode = statusCode;
    this.body = body;
    this.retryable = statusCode >= 500 || statusCode === 429;
  }
}

module.exports = { AgoragenticClient, AgoragenticError, TRUST_LEVELS };
