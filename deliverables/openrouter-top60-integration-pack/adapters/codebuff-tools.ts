import { getCustomToolDefinition } from '@codebuff/sdk';
import { z } from 'zod/v4';

const BASE_URL = process.env.AGORAGENTIC_BASE_URL || 'https://agoragentic.com';

class AgoragenticCodebuffError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'AgoragenticCodebuffError';
  }
}

async function request(path: string, init: RequestInit = {}) {
  const apiKey = process.env.AGORAGENTIC_API_KEY;
  if (!apiKey) throw new AgoragenticCodebuffError('AGORAGENTIC_API_KEY is required', 'missing_api_key', 401, false);
  const base = new URL(BASE_URL);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new AgoragenticCodebuffError('AGORAGENTIC_BASE_URL must use HTTPS unless loopback', 'unsafe_base_url', 400, false);
  }
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new AgoragenticCodebuffError(
    payload?.error?.message || payload?.message || `Agoragentic request failed with HTTP ${response.status}`,
    payload?.error?.code || payload?.code || 'agoragentic_request_failed', response.status, response.status === 429 || response.status >= 500,
  );
  return payload;
}
const jsonResult = (value: unknown) => [{ type: 'json' as const, value }];

export const agoragenticMatchTool = getCustomToolDefinition({
  toolName: 'agoragentic_match', description: 'Preview eligible providers without executing provider work.',
  inputSchema: z.object({ task: z.string().min(1) }),
  execute: async ({ task }) => jsonResult(await request(`/api/execute/match?task=${encodeURIComponent(task)}`)),
});
export const agoragenticQuoteTool = getCustomToolDefinition({
  toolName: 'agoragentic_quote', description: 'Create a no-spend quote before separately approved execution.',
  inputSchema: z.object({ task: z.string().min(1), input: z.record(z.string(), z.unknown()).default({}), constraints: z.record(z.string(), z.unknown()).default({}) }),
  execute: async ({ task, input, constraints }) => jsonResult(await request('/api/execute/quote', { method: 'POST', body: JSON.stringify({ task, input, constraints }) })),
});
export const agoragenticStatusTool = getCustomToolDefinition({
  toolName: 'agoragentic_status', description: 'Read status for an existing invocation.',
  inputSchema: z.object({ invocationId: z.string().min(1) }),
  execute: async ({ invocationId }) => jsonResult(await request(`/api/execute/status/${encodeURIComponent(invocationId)}`)),
});
export const agoragenticReceiptTool = getCustomToolDefinition({
  toolName: 'agoragentic_receipt', description: 'Read the normalized receipt for an existing invocation.',
  inputSchema: z.object({ invocationId: z.string().min(1) }),
  execute: async ({ invocationId }) => jsonResult(await request(`/api/execute/receipt/${encodeURIComponent(invocationId)}`)),
});
export const agoragenticCodebuffTools = [agoragenticMatchTool, agoragenticQuoteTool, agoragenticStatusTool, agoragenticReceiptTool];
// Deliberately no agoragentic_execute: Codebuff custom tools auto-execute and this candidate has no proven approval boundary.
