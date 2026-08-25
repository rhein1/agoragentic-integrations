import { tool } from '@openrouter/agent';
import { z } from 'zod';
import { AgoragenticClient } from './agoragentic-client.mjs';

const jsonObject = z.record(z.string(), z.unknown());
const matchConstraints = z.object({
  category: z.string().trim().min(1).optional(),
  max_cost: z.number().finite().nonnegative().optional(),
  max_latency_ms: z.number().int().nonnegative().optional(),
  payment_network: z.string().trim().min(1).optional(),
}).strict();
const executeConstraints = z.object({
  max_cost: z.number().finite().nonnegative().optional(),
  quote_id: z.string().trim().min(1).optional(),
}).catchall(z.unknown()).superRefine((value, context) => {
  if (value.max_cost === undefined && value.quote_id === undefined) {
    context.addIssue({ code: 'custom', message: 'max_cost or quote_id is required' });
  }
});

export function createAgoragenticOpenRouterTools({ client = new AgoragenticClient() } = {}) {
  const match = tool({
    name: 'agoragentic_match',
    description: 'Preview eligible Agoragentic providers before execution. No work is executed.',
    inputSchema: z.object({ task: z.string().min(1), constraints: matchConstraints.optional() }),
    execute: ({ task, constraints = {} }, context) => client.match({ task, constraints, signal: context?.signal }),
  });

  const quote = tool({
    name: 'agoragentic_quote',
    description: 'Preview a bounded routed task quote before paid or side-effecting execution.',
    inputSchema: z.object({ task: z.string().min(1), constraints: matchConstraints.optional() }),
    execute: ({ task, constraints = {} }, context) => client.quote({ task, constraints, signal: context?.signal }),
  });

  const execute = tool({
    name: 'agoragentic_execute',
    description: 'Route work through Agoragentic with a hard max_cost or durable quote_id. This may spend money or cause external side effects. Never automatically retry an outcome-unknown failure.',
    inputSchema: z.object({ task: z.string().min(1), input: jsonObject.optional(), constraints: executeConstraints }),
    requireApproval: true,
    execute: ({ task, input = {}, constraints }, context) => client.execute({ task, input, constraints, signal: context?.signal }),
  });

  const status = tool({
    name: 'agoragentic_status',
    description: 'Read status for an existing Agoragentic invocation.',
    inputSchema: z.object({ invocationId: z.string().min(1) }),
    execute: ({ invocationId }, context) => client.status({ invocationId, signal: context?.signal }),
  });

  const receipt = tool({
    name: 'agoragentic_receipt',
    description: 'Read the normalized receipt for an existing Agoragentic invocation.',
    inputSchema: z.object({ invocationId: z.string().min(1) }),
    execute: ({ invocationId }, context) => client.receipt({ invocationId, signal: context?.signal }),
  });

  return { match, quote, execute, status, receipt, all: [match, quote, execute, status, receipt] };
}
