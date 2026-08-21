import { tool } from '@openrouter/agent';
import { z } from 'zod';
import { AgoragenticClient } from './agoragentic-client.mjs';

const jsonObject = z.record(z.string(), z.unknown());

export function createAgoragenticOpenRouterTools({ client = new AgoragenticClient() } = {}) {
  const match = tool({
    name: 'agoragentic_match',
    description: 'Preview eligible Agoragentic providers before execution. No work is executed.',
    inputSchema: z.object({ task: z.string().min(1), constraints: jsonObject.optional() }),
    execute: ({ task, constraints = {} }, context) => client.match({ task, constraints, signal: context?.signal }),
  });

  const quote = tool({
    name: 'agoragentic_quote',
    description: 'Create a bounded quote before paid or side-effecting execution.',
    inputSchema: z.object({ task: z.string().min(1), input: jsonObject.optional(), constraints: jsonObject.optional() }),
    execute: ({ task, input = {}, constraints = {} }, context) => client.quote({ task, input, constraints, signal: context?.signal }),
  });

  const execute = tool({
    name: 'agoragentic_execute',
    description: 'Route work through Agoragentic. This may spend money or cause external side effects. Never automatically retry an outcome-unknown failure.',
    inputSchema: z.object({ task: z.string().min(1), input: jsonObject.optional(), constraints: jsonObject.optional() }),
    requireApproval: true,
    execute: ({ task, input = {}, constraints = {} }, context) => client.execute({ task, input, constraints, signal: context?.signal }),
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
