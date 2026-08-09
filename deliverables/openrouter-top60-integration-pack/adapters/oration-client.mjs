const DEFAULT_BASE_URL = 'https://www.oration.ai/api/v2/';
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
export class OrationClientError extends Error {
  constructor({ code, message, status = 0, retryable = false, details = null, cause }) {
    super(message, { cause }); this.name = 'OrationClientError'; this.code = code; this.status = status; this.retryable = retryable; this.details = details;
  }
}
export class OrationClient {
  constructor({ baseUrl = process.env.ORATION_BASE_URL || DEFAULT_BASE_URL, authMode = process.env.ORATION_AUTH_MODE || 'bearer', token = process.env.ORATION_API_TOKEN || '', apiKey = process.env.ORATION_API_KEY || '', workspaceId = process.env.ORATION_WORKSPACE_ID || '', fetchImpl = globalThis.fetch } = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
    const parsed = new URL(baseUrl);
    if (parsed.protocol !== 'https:' && !LOOPBACK.has(parsed.hostname)) throw new OrationClientError({ code: 'unsafe_base_url', message: 'Oration base URL must use HTTPS unless loopback', status: 400 });
    if (!['bearer', 'api_key_workspace'].includes(authMode)) throw new OrationClientError({ code: 'invalid_auth_mode', message: 'authMode must be bearer or api_key_workspace', status: 400 });
    Object.assign(this, { baseUrl: parsed, authMode, token, apiKey, workspaceId, fetchImpl });
  }
  authHeaders() {
    if (this.authMode === 'bearer') {
      if (!this.token) throw new OrationClientError({ code: 'missing_credentials', message: 'ORATION_API_TOKEN is required', status: 401 });
      return { Authorization: `Bearer ${this.token}` };
    }
    if (!this.apiKey || !this.workspaceId) throw new OrationClientError({ code: 'missing_credentials', message: 'ORATION_API_KEY and ORATION_WORKSPACE_ID are required', status: 401 });
    return { 'x-api-key': this.apiKey, 'x-workspace-id': this.workspaceId };
  }
  async request(path, { method = 'GET', body } = {}) {
    try {
      const response = await this.fetchImpl(new URL(path, this.baseUrl), { method, headers: { Accept: 'application/json', ...this.authHeaders(), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const payload = await response.json().catch(() => null);
      if (!response.ok) throw new OrationClientError({ code: payload?.code || 'oration_request_failed', message: payload?.message || `Oration request failed with HTTP ${response.status}`, status: response.status, retryable: response.status === 429 || response.status >= 500, details: payload });
      return payload;
    } catch (error) {
      if (error instanceof OrationClientError) throw error;
      throw new OrationClientError({ code: 'network_error', message: 'Oration network request failed', retryable: true, cause: error });
    }
  }
  getConversation(conversationId) {
    const id = String(conversationId || '').trim();
    if (!id) throw new OrationClientError({ code: 'invalid_conversation_id', message: 'conversationId is required', status: 400 });
    return this.request(`conversations/${encodeURIComponent(id)}`);
  }
  createConversations({ conversations, ownerApproved = false } = {}) {
    if (process.env.ORATION_ENABLE_CREATE !== 'true' || ownerApproved !== true) throw new OrationClientError({ code: 'creation_not_authorized', message: 'Creation requires ORATION_ENABLE_CREATE=true and ownerApproved=true', status: 403 });
    if (!Array.isArray(conversations) || conversations.length < 1 || conversations.length > 10) throw new OrationClientError({ code: 'invalid_conversations', message: 'conversations must contain 1 to 10 items', status: 400 });
    for (const [index, conversation] of conversations.entries()) {
      if (!conversation || typeof conversation !== 'object' || !String(conversation.agentId || '').trim()) throw new OrationClientError({ code: 'invalid_conversation', message: `conversations[${index}].agentId is required`, status: 400 });
      if (conversation.conversationType === 'telephony' && process.env.ORATION_ENABLE_TELEPHONY !== 'true') throw new OrationClientError({ code: 'telephony_not_authorized', message: 'Telephony requires ORATION_ENABLE_TELEPHONY=true', status: 403 });
      if (conversation.ignoreDND === true && process.env.ORATION_ALLOW_IGNORE_DND !== 'true') throw new OrationClientError({ code: 'ignore_dnd_not_authorized', message: 'ignoreDND=true requires ORATION_ALLOW_IGNORE_DND=true', status: 403 });
    }
    return this.request('conversations', { method: 'POST', body: { conversations } });
  }
}
