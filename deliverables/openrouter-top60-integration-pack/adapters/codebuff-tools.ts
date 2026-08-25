import { getCustomToolDefinition } from '@codebuff/sdk';
import { z } from 'zod/v4';

const DEFAULT_BASE_URL = 'https://agoragentic.com';

class AgoragenticCodebuffError extends Error {
  constructor(message: string, readonly code: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'AgoragenticCodebuffError';
  }
}

const jsonResult = (value: unknown) => [{ type: 'json' as const, value }];
const matchConstraints = z.object({
  category: z.string().trim().min(1).optional(),
  max_cost: z.number().finite().positive().optional(),
  max_latency_ms: z.number().int().nonnegative().optional(),
  payment_network: z.string().trim().min(1).optional(),
}).strict();

type MatchConstraints = z.infer<typeof matchConstraints>;

type MatchToolArgs = {
  task: string;
  constraints?: MatchConstraints;
};

type InvocationToolArgs = {
  invocationId: string;
};

const matchInputSchema: z.ZodType<MatchToolArgs, MatchToolArgs> = z.object({
  task: z.string().min(1),
  constraints: matchConstraints.optional(),
});

const invocationInputSchema: z.ZodType<InvocationToolArgs, InvocationToolArgs> = z.object({
  invocationId: z.string().min(1),
});

function matchPath(task: string, constraints: MatchConstraints = {}) {
  const params = new URLSearchParams({ task });
  if (constraints.category !== undefined) params.set('category', constraints.category);
  const maxCost = constraints.max_cost;
  if (maxCost !== undefined) {
    if (typeof maxCost !== 'number' || !Number.isFinite(maxCost) || maxCost <= 0) {
      throw new AgoragenticCodebuffError('constraints.max_cost must be a finite positive number', 'invalid_input', 400, false);
    }
    params.set('max_cost', String(maxCost));
  }
  if (constraints.max_latency_ms !== undefined) params.set('max_latency_ms', String(constraints.max_latency_ms));
  if (constraints.payment_network !== undefined) params.set('payment_network', constraints.payment_network);
  return `/api/execute/match?${params}`;
}

type CodebuffToolsOptions = {
  baseUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof globalThis.fetch;
};

export function createAgoragenticCodebuffTools({
  baseUrl = process.env.AGORAGENTIC_BASE_URL || DEFAULT_BASE_URL,
  apiKey = process.env.AGORAGENTIC_API_KEY || '',
  fetchImpl = globalThis.fetch,
}: CodebuffToolsOptions = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  const base = new URL(baseUrl);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new AgoragenticCodebuffError('AGORAGENTIC_BASE_URL must use HTTPS unless loopback', 'unsafe_base_url', 400, false);
  }

  async function request(path: string, init: RequestInit = {}) {
    if (!apiKey) throw new AgoragenticCodebuffError('AGORAGENTIC_API_KEY is required', 'missing_api_key', 401, false);
    const response = await fetchImpl(new URL(path, base), {
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

  const match = getCustomToolDefinition<'agoragentic_match', MatchToolArgs, MatchToolArgs>({
    toolName: 'agoragentic_match', description: 'Preview eligible providers without executing provider work.',
    inputSchema: matchInputSchema,
    execute: async ({ task, constraints }) => jsonResult(await request(matchPath(task, constraints ?? {}))),
  });
  const quote = getCustomToolDefinition<'agoragentic_quote', MatchToolArgs, MatchToolArgs>({
    toolName: 'agoragentic_quote', description: 'Preview a bounded no-spend routed task quote before separately approved execution.',
    inputSchema: matchInputSchema,
    execute: async ({ task, constraints }) => jsonResult(await request(matchPath(task, constraints ?? {}))),
  });
  const status = getCustomToolDefinition<'agoragentic_status', InvocationToolArgs, InvocationToolArgs>({
    toolName: 'agoragentic_status', description: 'Read status for an existing invocation.',
    inputSchema: invocationInputSchema,
    execute: async ({ invocationId }) => jsonResult(await request(`/api/execute/status/${encodeURIComponent(invocationId)}`)),
  });
  const receipt = getCustomToolDefinition<'agoragentic_receipt', InvocationToolArgs, InvocationToolArgs>({
    toolName: 'agoragentic_receipt', description: 'Read the normalized receipt for an existing invocation.',
    inputSchema: invocationInputSchema,
    execute: async ({ invocationId }) => jsonResult(await request(`/api/commerce/receipts/${encodeURIComponent(invocationId)}`)),
  });

  return { match, quote, status, receipt, all: [match, quote, status, receipt] };
}

const defaultTools = createAgoragenticCodebuffTools();
export const agoragenticMatchTool = defaultTools.match;
export const agoragenticQuoteTool = defaultTools.quote;
export const agoragenticStatusTool = defaultTools.status;
export const agoragenticReceiptTool = defaultTools.receipt;
export const agoragenticCodebuffTools = defaultTools.all;
// Deliberately no agoragentic_execute: Codebuff custom tools auto-execute and this candidate has no proven approval boundary.
