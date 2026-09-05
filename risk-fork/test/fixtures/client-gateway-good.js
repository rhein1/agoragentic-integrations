'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
let toolCalls = 0;
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') {
    if (message.params?.mode === 'error') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id, error: { code: -32090, message: 'fixture initialize error' },
      })}\n`);
      return;
    }
    if (message.params?.mode === 'hang') return;
    result = {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-risk-forkd', version: '1.0.0' },
    };
  } else if (message.method === 'tools/list') {
    if (message.params?.mode === 'error') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0', id: message.id, error: { code: -32091, message: 'fixture list error' },
      })}\n`);
      return;
    }
    if (message.params?.mode === 'hang') return;
    result = {
      tools: [{
        name: 'risk_fork_protect',
        description: 'Fixture-only exact Risk Fork gateway tool.',
        inputSchema: {
          type: 'object',
          properties: { operation: { type: 'string' } },
          required: ['operation'],
          additionalProperties: false,
        },
      }],
    };
  } else if (message.method === 'tools/call') {
    if (message.params.arguments.operation === 'server-request-bypass') {
      process.stdout.write(`${JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        method: 'sampling/createMessage',
        params: { messages: [] },
      })}\n`);
      return;
    }
    if (message.params.arguments.operation === 'hang') return;
    toolCalls += 1;
    result = {
      content: [{
        type: 'text',
        text: JSON.stringify({
          status: 'fixture_only',
          operation: message.params.arguments.operation,
          invocation_count: toolCalls,
        }),
      }],
    };
  } else {
    result = {};
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
