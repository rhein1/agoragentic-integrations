const DEFAULT_BASE_URL = 'https://agoragentic.com';

export class AgoragenticAdapterError extends Error {
  constructor({ code, message, status, retryable = false, details = null }) {
    super(message);
    this.name = 'AgoragenticAdapterError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
  }
}

function getApiKey() {
  const apiKey = process.env.AGORAGENTIC_API_KEY;
  if (!apiKey) {
    throw new AgoragenticAdapterError({
      code: 'missing_api_key',
      message: 'AGORAGENTIC_API_KEY is required for authenticated router calls.',
      status: 401
    });
  }
  return apiKey;
}

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${process.env.AGORAGENTIC_BASE_URL || DEFAULT_BASE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new AgoragenticAdapterError({
      code: payload?.error?.code || payload?.code || 'router_request_failed',
      message: payload?.error?.message || payload?.message || `Router request failed with HTTP ${response.status}.`,
      status: response.status,
      retryable: response.status === 429 || response.status >= 500,
      details: payload
    });
  }
  return payload;
}

/** Preview eligible providers before any routed execution. */
export async function agoragentic_match(task) {
  if (!task || typeof task !== 'string') {
    throw new AgoragenticAdapterError({
      code: 'invalid_task',
      message: 'task must be a non-empty string.',
      status: 400
    });
  }
  return request(`/api/execute/match?task=${encodeURIComponent(task)}`);
}

/** Route work through the marketplace and return the execution result plus receipt reference. */
export async function agoragentic_execute(task, input, { maxCost } = {}) {
  if (!task || typeof task !== 'string') {
    throw new AgoragenticAdapterError({
      code: 'invalid_task',
      message: 'task must be a non-empty string.',
      status: 400
    });
  }
  return request('/api/execute', {
    method: 'POST',
    body: {
      task,
      input,
      ...(maxCost === undefined ? {} : { constraints: { max_cost: maxCost } })
    }
  });
}
