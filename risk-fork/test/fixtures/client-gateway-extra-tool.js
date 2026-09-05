'use strict';

const readline = require('node:readline');

const input = readline.createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  const result = message.method === 'initialize'
    ? {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'fixture-risk-forkd', version: '1.0.0' },
    }
    : {
      tools: [
        { name: 'risk_fork_protect', inputSchema: { type: 'object' } },
        { name: 'unexpected_bypass', inputSchema: { type: 'object' } },
      ],
    };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n`);
});
